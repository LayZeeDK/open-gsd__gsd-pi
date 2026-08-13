import type { ImageContent } from "@gsd/pi-ai";
import { dispatchSlashCommand } from "../slash-command-handlers.js";
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";
import type { ContextualTips } from "@gsd/agent-core";
import * as modeInit from "../interactive-mode-init.js";

/**
 * Consume and clear any pending pasted images from the host.
 * Returns undefined if there are no pending images.
 */
function consumePendingImages(host: InteractiveModeStateHost): ImageContent[] | undefined {
	if (host.pendingImages.length === 0) return undefined;
	const images = [...host.pendingImages];
	host.pendingImages.length = 0;
	return images;
}

function markEditorSubmitLatency(host: InteractiveModeStateHost, images: ImageContent[] | undefined): void {
	host.session.beginTurnLatency?.({ source: "tui", trigger: "editor_submit" });
	host.session.markTurnLatency?.("tui.editor_submit", { images: images?.length ?? 0 });
}

function wireEditorSubmitHandler(
	host: InteractiveModeStateHost & { editor: { onSubmit?: (text: string) => void | Promise<void> } },
	handler: (text: string) => Promise<void>,
): void {
	host.defaultEditor.onSubmit = handler;
	if (host.editor !== host.defaultEditor) {
		host.editor.onSubmit = handler;
	}
}

export function setupEditorSubmitHandler(host: InteractiveModeStateHost & {
	getSlashCommandContext: () => any;
	handleBashCommand: (command: string, excludeFromContext?: boolean) => Promise<void>;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	showTip: (message: string) => void;
	updateEditorBorderColor: () => void;
	isExtensionCommand: (text: string) => boolean;
	isKnownSlashCommand: (text: string) => boolean;
	queueCompactionMessage: (text: string, mode: "steer" | "followUp") => void;
	updatePendingMessagesDisplay: () => void;
	flushPendingBashComponents: () => void;
	contextualTips: ContextualTips;
	getContextPercent: () => number | undefined;
	options?: { submitPromptsDirectly?: boolean };
}): void {
	const onSubmit = async (text: string) => {
		text = text.trim();
		if (!text) return;

		if (!host.session.isStreaming) {
			host.clearBlockingError();
		}

		modeInit.dismissStartupHeader(host as Parameters<typeof modeInit.dismissStartupHeader>[0]);

		if (text.startsWith("/") && !looksLikeFilePath(text)) {
			const handled = await dispatchSlashCommand(text, host.getSlashCommandContext());
			if (handled) {
				host.editor.setText("");
				consumePendingImages(host); // discard images on slash command
				return;
			}
			if (!host.isKnownSlashCommand(text)) {
				const command = text.split(/\s/)[0];
				host.showError(`Unknown command: ${command}. Use slash autocomplete to see available commands.`);
				host.editor.setText("");
				return;
			}
		}

		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (host.session.isBashRunning) {
					host.showWarning("A bash command is already running. Press Esc to cancel it first.");
					host.editor.setText(text);
					return;
				}
				// Track included bash commands for double-bang tip
				if (!isExcluded) {
					host.contextualTips.recordBashIncluded();
				}
				host.editor.addToHistory?.(text);
				await host.handleBashCommand(command, isExcluded);
				host.isBashMode = false;
				host.updateEditorBorderColor();
				consumePendingImages(host); // discard images on bash command
				return;
			}
		}

		// Evaluate contextual tips before sending to agent
		const tip = host.contextualTips.evaluate({
			input: text,
			isStreaming: host.session.isStreaming,
			thinkingLevel: host.session.thinkingLevel,
			contextPercent: host.getContextPercent(),
		});
		if (tip) {
			host.showTip(tip);
		}

		if (host.onInputCallback) {
			host.onInputCallback(text);
			host.editor.addToHistory?.(text);
			return;
		}

		// Consume pending images for prompt submissions
		const images = consumePendingImages(host);

		if (host.session.isCompacting) {
			if (host.isExtensionCommand(text)) {
				host.editor.addToHistory?.(text);
				host.editor.setText("");
				try {
					await host.session.prompt(text, { images });
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					host.showError(errorMessage);
				}
			} else {
				host.queueCompactionMessage(text, "steer");
			}
			return;
		}

		if (host.session.isStreaming) {
			host.editor.addToHistory?.(text);
			host.editor.setText("");
			await host.session.prompt(text, { streamingBehavior: "steer", images });
			host.updatePendingMessagesDisplay();
			host.ui.requestRender();
			return;
		}

		host.flushPendingBashComponents();

		// Both settings of submitPromptsDirectly dispatched identically, so this is
		// the single idle-submit site. It still goes through session.prompt so user
		// input is not silently discarded.
		//
		// streamingBehavior is inert unless the session is streaming, so it changes
		// nothing on this path except in one case: the isStreaming check above is a
		// check-then-act, and prompt() re-reads the flag after awaiting its
		// extension-command and input-handler hooks. If the agent enters streaming
		// inside that window the submit is queued instead of throwing.
		//
		// followUp, not steer, for that contingency. This submit observed an IDLE
		// session, so the run it would steer is one the user never saw. Ordering
		// after it is the conservative reading, it matches Alt+Enter (which routes
		// its idle case through here, see interactive-key-handlers.ts), and unlike
		// steer it cannot strand: agent-loop.ts polls the follow-up queue when the
		// agent would otherwise stop. A submit that DID observe streaming still
		// steers, in the branch above.
		host.editor.addToHistory?.(text);
		// Normally a no-op, since Editor.submitValue() clears before calling this.
		// Alt+Enter's idle case reaches us via CustomEditor.onAction, which does not.
		host.editor.setText("");
		try {
			markEditorSubmitLatency(host, images);
			await host.session.prompt(text, { streamingBehavior: "followUp", images });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			host.showError(errorMessage);
		}
		// A queued submit is otherwise invisible: nothing subscribes to queue_update,
		// so the display is push-based and the text would leave no trace at all.
		host.updatePendingMessagesDisplay();
		host.ui.requestRender();
	};

	wireEditorSubmitHandler(host, onSubmit);
}

/**
 * Distinguish absolute file paths from slash commands (#3478).
 * Drag-and-drop inserts paths like "/Users/name/Desktop/file.png" which
 * should be treated as plain text input, not a /Users command.
 *
 * Heuristic: a slash command is a single token like "/help" or "/gsd auto".
 * File paths have a second "/" within the first token (e.g., "/Users/...").
 */
function looksLikeFilePath(text: string): boolean {
	const firstToken = text.split(/\s/)[0];
	// Slash commands: /help, /gsd, /commit — single "/" at start only.
	// File paths: /Users/name/file, /home/user/file, /tmp/x — contain "/" after position 0.
	return firstToken.indexOf("/", 1) !== -1;
}
