import * as vscode from "vscode";

import {
  ExactPrefixExpansionController,
  parseExpandAtPrefixOptions,
  SmartSnippetCompletionProvider,
} from "./completion/index.js";
import { SnippetRegistry } from "./config/index.js";
import { SmartSnippetSessionManager } from "./session/index.js";

const EXPAND_AT_PREFIX_COMMAND = "smartSnippets.expandAtPrefix";

async function runUserCommand(
  output: vscode.OutputChannel,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[command] ${message}`);
    await vscode.window.showErrorMessage(`Smart Snippets: ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Smart Snippets");
  const registry = new SnippetRegistry(context, output);
  const sessions = new SmartSnippetSessionManager(output);
  const expansionController = new ExactPrefixExpansionController(
    registry,
    (snapshot, editor) => sessions.captureInsertion(snapshot, editor),
    output,
  );

  context.subscriptions.push(output, registry, sessions, expansionController);
  context.subscriptions.push(
    vscode.commands.registerCommand("smartSnippets.nextPlaceholder", async () => {
      await sessions.advanceToNextPlaceholder();
    }),
    vscode.commands.registerCommand(EXPAND_AT_PREFIX_COMMAND, async (options: unknown) => {
      const parsedOptions = parseExpandAtPrefixOptions(options);
      const expanded = parsedOptions.requestValid
        ? await expansionController.expandAtExactPrefix(parsedOptions.requestedSnippet)
        : false;
      return expanded;
    }),
    vscode.commands.registerCommand("smartSnippets.openUserSnippets", async () => {
      await runUserCommand(output, async () => registry.openUserSnippetFile());
    }),
    vscode.commands.registerCommand("smartSnippets.openWorkspaceSnippets", async () => {
      await runUserCommand(output, async () => {
        const uri = await registry.openWorkspaceSnippetFile();
        if (uri === undefined) {
          await vscode.window.showInformationMessage(
            "Smart Snippets: Open a folder or workspace before creating workspace snippets.",
          );
        }
      });
    }),
    vscode.commands.registerCommand("smartSnippets.reload", async () => {
      await runUserCommand(output, async () => {
        await registry.reload();
        void vscode.window.showInformationMessage("Smart Snippets reloaded.");
      });
    }),
  );

  await Promise.all([registry.initialize(), sessions.initialize()]);
  await expansionController.initialize();

  const completionProvider = new SmartSnippetCompletionProvider(
    registry,
    EXPAND_AT_PREFIX_COMMAND,
  );
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider("*", completionProvider),
  );
  output.appendLine("Smart Snippets activated.");
}

export function deactivate(): void {
  // ExtensionContext disposes all registered resources.
}
