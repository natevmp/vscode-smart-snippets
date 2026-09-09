import assert from "node:assert/strict";

import * as vscode from "vscode";

const EXTENSION_ID = "smart-snippets.smart-snippets";
const FIXTURE_FILE = "sample.txt";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, message);
}

function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

async function replaceDocument(editor: vscode.TextEditor, text: string): Promise<void> {
  const document = editor.document;
  const changed = await editor.edit((builder) => {
    builder.replace(
      new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
      text,
    );
  });
  assert.equal(changed, true);
  editor.selection = new vscode.Selection(document.positionAt(text.length), document.positionAt(text.length));
}

async function getCompletion(
  document: vscode.TextDocument,
  prefix: string,
): Promise<vscode.CompletionItem> {
  const position = document.positionAt(document.getText().length);
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    document.uri,
    position,
  );
  assert.ok(completions, "Expected a completion list");
  const item = completions.items.find((candidate) => completionLabel(candidate) === prefix);
  assert.ok(item, `Expected completion ${prefix}`);
  return item;
}

async function acceptCompletion(
  editor: vscode.TextEditor,
  item: vscode.CompletionItem,
): Promise<void> {
  assert.ok(item.range instanceof vscode.Range);
  const inserted = typeof item.insertText === "string"
    ? await editor.edit((builder) => { builder.replace(item.range as vscode.Range, item.insertText as string); })
    : item.insertText instanceof vscode.SnippetString
      ? await editor.insertSnippet(item.insertText, item.range, {
          undoStopBefore: true,
          undoStopAfter: true,
        })
      : false;
  assert.equal(inserted, true);
  if (typeof item.insertText === "string") {
    const cursor = item.range.start.translate(0, item.insertText.length);
    editor.selection = new vscode.Selection(cursor, cursor);
  }
  if (item.command !== undefined) {
    await vscode.commands.executeCommand(
      item.command.command,
      ...(item.command.arguments ?? []),
    );
  }
}

async function insertAtCursor(editor: vscode.TextEditor, text: string): Promise<void> {
  const previousLength = editor.document.getText().length;
  const selection_sid = [...editor.selections];
  const replacedLength = selection_sid.reduce((length, selection) => (
    length + editor.document.offsetAt(selection.end) - editor.document.offsetAt(selection.start)
  ), 0);
  const inserted = await editor.edit((builder) => {
    for (const selection of selection_sid) {
      builder.replace(selection, text);
    }
  });
  assert.equal(inserted, true);
  editor.selections = selection_sid.map((selection) => {
    const cursor = selection.start.translate(0, text.length);
    return new vscode.Selection(cursor, cursor);
  });
  assert.equal(
    editor.document.getText().length,
    previousLength - replacedLength + text.length * selection_sid.length,
  );
}

async function leaveDriver(
  editor: vscode.TextEditor,
  selection_sid: readonly vscode.Selection[],
): Promise<void> {
  editor.selections = [...selection_sid];
  await new Promise((resolve) => setTimeout(resolve, 20));
}

suite("Smart Snippets extension", () => {
  let editor: vscode.TextEditor;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Expected extension ${EXTENSION_ID}`);
    await extension.activate();

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "Expected the integration fixture workspace");
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder.uri, FIXTURE_FILE),
    );
    editor = await vscode.window.showTextDocument(document);
  });

  teardown(async () => {
    await replaceDocument(editor, "");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  test("offers punctuation prefixes and preserves native tab stops", async () => {
    await replaceDocument(editor, "#h1");
    const item = await getCompletion(editor.document, "#h1");
    assert.ok(item.command, "Dynamic completion should initialize a session");
    await acceptCompletion(editor, item);

    assert.equal(editor.document.getText(), "## @h1 \n\n");
    assert.equal(editor.selection.active.line, 0);
    assert.equal(editor.selection.active.character, 7);
    await insertAtCursor(editor, "Bayesian");
    await leaveDriver(editor, [new vscode.Selection(1, 0, 1, 0)]);
    await waitFor(
      () => editor.document.lineAt(0).text.length === 30,
      "Expected padding after leaving the driver",
    );

    const firstLine = editor.document.lineAt(0).text;
    assert.equal(firstLine.length, 30);
    assert.match(firstLine, /^## @h1 Bayesian-+$/u);
  });

  test("expands an exact punctuation prefix directly", async () => {
    await replaceDocument(editor, "#h1");
    const expanded = await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    );

    assert.equal(expanded, true);
    assert.equal(editor.document.getText(), "## @h1 \n\n");
    await insertAtCursor(editor, "Tab");
    await leaveDriver(editor, [new vscode.Selection(1, 0, 1, 0)]);
    await waitFor(
      () => editor.document.lineAt(0).text.length === 30,
      "Expected direct expansion padding",
    );
  });

  test("treats a dynamic completion prefix as literal text", async () => {
    await replaceDocument(editor, "$1");
    const item = await getCompletion(editor.document, "$1");
    assert.equal(item.insertText, "$1");
    await acceptCompletion(editor, item);

    assert.equal(editor.document.getText(), "Dollar: \n");
    await insertAtCursor(editor, "value");
    await leaveDriver(editor, [new vscode.Selection(1, 0, 1, 0)]);
    await waitFor(
      () => editor.document.lineAt(0).text.length === 20,
      "Expected padding for a literal dollar prefix",
    );
    assert.equal(editor.document.lineAt(0).text, "Dollar: value.......");
  });

  test("coordinates padding through the next-placeholder command", async () => {
    await replaceDocument(editor, "#default");
    const expanded = await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    );
    assert.equal(expanded, true);

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(0).text.length === 20,
      "Expected command-coordinated padding",
    );
    assert.equal(editor.document.lineAt(0).text, "Default: value------");
  });

  test("repeats and truncates a multi-character fill pattern", async () => {
    await replaceDocument(editor, "#pattern");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(0).text === "Pattern: xabababa",
      "Expected repeated and truncated pattern padding",
    );
  });

  test("navigates a transformed placeholder mirror and evaluates its pad", async () => {
    await replaceDocument(editor, "#transform");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);
    assert.equal(editor.document.lineAt(0).text, "Transform: value -> value");
    assert.equal(editor.document.getText(editor.selection), "value");

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(0).text.length === 32,
      "Expected padding driven by the transformed placeholder mirror",
    );
    assert.equal(editor.document.lineAt(0).text, "Transform: value -> VALUE~~~~~~~");
    assert.equal(editor.document.getText(editor.selection), "next");
  });

  test("evaluates named pads across distinct and mirrored tab stops", async () => {
    await replaceDocument(editor, "#multi");
    const expanded = await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    );
    assert.equal(expanded, true);
    assert.equal(
      editor.document.getText(),
      "Primary: alpha tail\nMirror: alpha tail\nSecondary: beta tail\n",
    );

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(0).text.length === 24
        && editor.document.lineAt(1).text.length === 26,
      "Expected every pad driven by mirrored tab stop 1",
    );
    assert.equal(editor.document.lineAt(0).text, "Primary: alpha tail-----");
    assert.equal(editor.document.lineAt(1).text, "Mirror: alpha tail........");
    assert.equal(editor.document.lineAt(2).text, "Secondary: beta tail");
    assert.equal(editor.selection.active.line, 2);
    assert.equal(editor.document.getText(editor.selection), "beta");

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(2).text.length === 28,
      "Expected the pad driven by tab stop 2",
    );
    assert.equal(editor.document.lineAt(2).text, "Secondary: beta tail========");
    assert.equal(editor.selection.active.line, 3);
  });

  test("does not rearm settled pads while later named pads remain pending", async () => {
    await replaceDocument(editor, "#multi");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(0).text.endsWith("-----"),
      "Expected initial named padding",
    );
    assert.equal(await editor.edit((builder) => {
      builder.replace(new vscode.Range(0, 9, 0, 14), "X");
    }), true);

    assert.equal(editor.document.lineAt(0).text.match(/-+$/u)?.[0].length, 5);
    assert.ok(editor.document.lineAt(0).text.length < 24);
    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(2).text.length === 28,
      "Expected the later pad to remain active",
    );
    assert.equal(editor.document.lineAt(0).text.match(/-+$/u)?.[0].length, 5);
  });

  test("tracks a pending pad across an intermediate native tab stop", async () => {
    await replaceDocument(editor, "#later");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    assert.equal(editor.selection.active.line, 1);
    assert.equal(editor.document.getText(editor.selection), "two");
    assert.equal(editor.document.lineAt(1).text, "Later: two end");

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(1).text.length === 24,
      "Expected later padding after leaving tab stop 2",
    );
    assert.equal(editor.document.lineAt(1).text, "Later: two end----------");
    assert.equal(editor.selection.active.line, 2);
  });

  test("tracks backward navigation between groups with different mirror counts", async () => {
    await replaceDocument(editor, "#unequal");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    assert.equal(editor.selections.length, 1);
    assert.equal(editor.document.getText(editor.selection), "two");

    await vscode.commands.executeCommand("jumpToPrevSnippetPlaceholder");
    assert.equal(editor.selections.length, 2);
    assert.equal(editor.document.getText(editor.selections[0]), "one");
    assert.equal(editor.document.getText(editor.selections[1]), "one");

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    assert.equal(editor.selections.length, 1);
    assert.equal(editor.document.getText(editor.selection), "two");
    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    assert.equal(editor.document.getText(editor.selection), "three");
    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(3).text.length === 28,
      "Expected the later pad after backward navigation across unequal groups",
    );
    assert.equal(editor.document.lineAt(3).text, "Later: three end------------");
  });

  test("serializes overlapping next-placeholder commands", async () => {
    await replaceDocument(editor, "#multi");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    const firstAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    const secondAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await Promise.all([firstAdvance, secondAdvance]);

    assert.equal(editor.selection.active.line, 3);
    assert.equal(editor.document.lineAt(0).text, "Primary: alpha tail-----");
    assert.equal(editor.document.lineAt(1).text, "Mirror: alpha tail........");
    assert.equal(editor.document.lineAt(2).text, "Secondary: beta tail========");
  });

  test("forwards queued commands after the final pad settles", async () => {
    await replaceDocument(editor, "#h1");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    const firstAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    const secondAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await Promise.all([firstAdvance, secondAdvance]);

    assert.equal(editor.selection.active.line, 2);
    assert.equal(editor.selection.active.character, 0);
    assert.equal(editor.document.lineAt(0).text.length, 30);
    assert.match(editor.document.lineAt(0).text, /^## @h1 -+$/u);
  });

  test("forwards accepted tickets through an unvisited positive group to the final stop", async () => {
    await replaceDocument(editor, "#early");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    const firstAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    const secondAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    const thirdAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await Promise.all([firstAdvance, secondAdvance, thirdAdvance]);

    assert.equal(editor.document.lineAt(0).text, "a-------");
    assert.equal(editor.selection.active.line, 3);
    assert.equal(editor.selection.active.character, 0);
  });

  test("drops an accepted old advance when a static snippet replaces the completed session", async () => {
    await replaceDocument(editor, "#h1");
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    const firstAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    const insertReplacement = firstAdvance.then(async () => {
      const document = editor.document;
      const inserted = await editor.insertSnippet(
        new vscode.SnippetString("Static ${1:replacement} ${2:target}$0"),
        new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
      );
      assert.equal(inserted, true);
    });
    const staleAdvance = vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await Promise.all([firstAdvance, insertReplacement, staleAdvance]);

    assert.equal(editor.document.getText(), "Static replacement target");
    assert.equal(editor.document.getText(editor.selection), "replacement");
  });

  test("does not expand a prefix embedded in another token", async () => {
    await replaceDocument(editor, "value#h1");
    const expanded = await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    );

    assert.equal(expanded, false);
    assert.equal(editor.document.getText(), "value#h1");
  });

  test("does not mutate padding after its one-shot evaluation", async () => {
    await replaceDocument(editor, "#h1");
    await acceptCompletion(editor, await getCompletion(editor.document, "#h1"));
    await insertAtCursor(editor, "Bayesian");
    await leaveDriver(editor, [new vscode.Selection(1, 0, 1, 0)]);
    await waitFor(
      () => editor.document.lineAt(0).text.length === 30,
      "Expected one-shot padding",
    );
    const firstPaddingLength = editor.document.lineAt(0).text.match(/-+$/u)?.[0].length;
    assert.equal(firstPaddingLength, 15);

    editor.selection = new vscode.Selection(0, 15, 0, 15);
    await insertAtCursor(editor, "X");

    const secondLineText = editor.document.lineAt(0).text;
    assert.equal(secondLineText.length, 31);
    assert.equal(secondLineText.match(/-+$/u)?.[0].length, 15);
    assert.match(secondLineText, /^## @h1 BayesianX-+$/u);
  });

  test("does not overwrite generated text changed by the user", async () => {
    await replaceDocument(editor, "#h1");
    await acceptCompletion(editor, await getCompletion(editor.document, "#h1"));
    await insertAtCursor(editor, "Bayesian");
    await leaveDriver(editor, [new vscode.Selection(1, 0, 1, 0)]);
    await waitFor(
      () => editor.document.lineAt(0).text.length === 30,
      "Expected generated padding",
    );

    const line = editor.document.lineAt(0).text;
    const firstPadCharacter = line.indexOf("-");
    assert.ok(firstPadCharacter >= 0);
    await editor.edit((builder) => {
      builder.replace(new vscode.Range(0, firstPadCharacter, 0, firstPadCharacter + 1), "=");
    });

    editor.selection = new vscode.Selection(0, firstPadCharacter, 0, firstPadCharacter);
    await insertAtCursor(editor, "X");

    assert.ok(editor.document.lineAt(0).text.includes("="));
  });

  test("inserts no padding when content overflows", async () => {
    await replaceDocument(editor, "#over");
    await acceptCompletion(editor, await getCompletion(editor.document, "#over"));
    await insertAtCursor(editor, "a very long value");
    await leaveDriver(editor, [new vscode.Selection(1, 0, 1, 0)]);

    assert.equal(editor.document.lineAt(0).text, "Value: a very long value");
  });

  test("evaluates independent multi-cursor instances", async () => {
    await replaceDocument(editor, "#h1\n#h1");
    editor.selections = [
      new vscode.Selection(0, 3, 0, 3),
      new vscode.Selection(1, 3, 1, 3),
    ];
    const expanded = await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    );
    assert.equal(expanded, true);

    await insertAtCursor(editor, "Multi");
    await leaveDriver(editor, [
      new vscode.Selection(1, 0, 1, 0),
      new vscode.Selection(4, 0, 4, 0),
    ]);
    await waitFor(
      () => editor.document.lineAt(0).text.length === 30
        && editor.document.lineAt(3).text.length === 30,
      "Expected independent multi-cursor padding",
    );
  });

  test("discards a partial multicursor exit when Tab interception is disabled", async () => {
    const configuration = vscode.workspace.getConfiguration("smartSnippets");
    const originalWorkspaceValue = configuration.inspect<boolean>(
      "enableTabInterception",
    )?.workspaceValue;
    await configuration.update(
      "enableTabInterception",
      false,
      vscode.ConfigurationTarget.Workspace,
    );

    try {
      await replaceDocument(editor, "#h1\n#h1");
      editor.selections = [
        new vscode.Selection(0, 3, 0, 3),
        new vscode.Selection(1, 3, 1, 3),
      ];
      assert.equal(await vscode.commands.executeCommand<boolean>(
        "smartSnippets.expandAtPrefix",
      ), true);
      await insertAtCursor(editor, "Partial");
      assert.equal(editor.selections.length, 2);

      const firstSelection = editor.selections[0];
      assert.ok(firstSelection);
      editor.selections = [
        firstSelection,
        new vscode.Selection(4, 0, 4, 0),
      ];
      await new Promise((resolve) => setTimeout(resolve, 200));

      editor.selections = [
        new vscode.Selection(1, 0, 1, 0),
        new vscode.Selection(4, 0, 4, 0),
      ];
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(editor.document.lineAt(0).text, "## @h1 Partial");
      assert.equal(editor.document.lineAt(3).text, "## @h1 Partial");
    } finally {
      await configuration.update(
        "enableTabInterception",
        originalWorkspaceValue,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });

  test("evaluates multiple named pads for independent multi-cursor instances", async () => {
    await replaceDocument(editor, "#multi\n#multi");
    editor.selections = [
      new vscode.Selection(0, 6, 0, 6),
      new vscode.Selection(1, 6, 1, 6),
    ];
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);

    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(0).text.length === 24
        && editor.document.lineAt(1).text.length === 26
        && editor.document.lineAt(4).text.length === 24
        && editor.document.lineAt(5).text.length === 26,
      "Expected mirrored named pads for both snippet instances",
    );
    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(2).text.length === 28
        && editor.document.lineAt(6).text.length === 28,
      "Expected later named pads for both snippet instances",
    );
  });

  test("evaluates multi-cursor pads when the implicit final stop collapses", async () => {
    await replaceDocument(editor, "#implicit\n#implicit");
    editor.selections = [
      new vscode.Selection(0, 9, 0, 9),
      new vscode.Selection(1, 9, 1, 9),
    ];
    assert.equal(await vscode.commands.executeCommand<boolean>(
      "smartSnippets.expandAtPrefix",
    ), true);
    assert.equal(editor.document.getText(), "\n");
    assert.equal(editor.selections.length, 2);

    await insertAtCursor(editor, "x");
    await vscode.commands.executeCommand("smartSnippets.nextPlaceholder");
    await waitFor(
      () => editor.document.lineAt(0).text === "x-------"
        && editor.document.lineAt(1).text === "x-------",
      "Expected both pads after the implicit final tab stop",
    );
  });

  test("leaves static snippets entirely native", async () => {
    await replaceDocument(editor, "#static");
    const item = await getCompletion(editor.document, "#static");
    assert.equal(item.command, undefined);
    await acceptCompletion(editor, item);
    assert.equal(editor.document.getText(), "static ");
  });

  test("reloads workspace JSONC and retains the last valid snapshot", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const configUri = vscode.Uri.joinPath(folder.uri, ".vscode", "smart-snippets.jsonc");
    const original = await vscode.workspace.fs.readFile(configUri);
    const replacement = new TextEncoder().encode(`{
      "Reloaded": {
        "prefix": "#new",
        "body": "new $1$0"
      }
    }`);

    try {
      await vscode.workspace.fs.writeFile(configUri, replacement);
      await vscode.commands.executeCommand("smartSnippets.reload");
      await replaceDocument(editor, "#new");
      assert.equal(completionLabel(await getCompletion(editor.document, "#new")), "#new");

      await vscode.workspace.fs.writeFile(
        configUri,
        new TextEncoder().encode(`[${",".repeat(1_000)}]`),
      );
      await vscode.commands.executeCommand("smartSnippets.reload");
      await replaceDocument(editor, "#new");
      assert.equal(completionLabel(await getCompletion(editor.document, "#new")), "#new");
      const diagnostic_did = vscode.languages.getDiagnostics(configUri);
      assert.ok(diagnostic_did.length > 0);
      assert.ok(diagnostic_did.length <= 101, "Parse diagnostics must remain bounded");

      const nestedJson = `${"[".repeat(101)}0${"]".repeat(101)}`;
      await vscode.workspace.fs.writeFile(configUri, new TextEncoder().encode(nestedJson));
      await vscode.commands.executeCommand("smartSnippets.reload");
      await replaceDocument(editor, "#new");
      assert.equal(completionLabel(await getCompletion(editor.document, "#new")), "#new");
      assert.match(
        vscode.languages.getDiagnostics(configUri)[0]?.message ?? "",
        /nesting exceeds/u,
      );
    } finally {
      await vscode.workspace.fs.writeFile(configUri, original);
      await vscode.commands.executeCommand("smartSnippets.reload");
    }
  });
});
