import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index");
  const fixtureWorkspace = path.resolve(extensionDevelopmentPath, "test/fixtures/workspace");
  const testWorkspace = await mkdtemp(path.join(tmpdir(), "ss-workspace-"));
  await cp(fixtureWorkspace, testWorkspace, { recursive: true });
  const userDataDirectory = path.join(tmpdir(), `ss-vscode-user-${process.pid}`);
  const extensionsDirectory = path.join(tmpdir(), `ss-vscode-ext-${process.pid}`);
  const vscodeVersion = process.env.VSCODE_TEST_VERSION;
  let vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
  if (process.platform === "darwin" && !existsSync(vscodeExecutablePath)) {
    const renamedExecutable = path.join(path.dirname(vscodeExecutablePath), "Code");
    if (existsSync(renamedExecutable)) {
      vscodeExecutablePath = renamedExecutable;
    }
  }

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath,
      launchArgs: [
        testWorkspace,
        "--disable-extensions",
        `--user-data-dir=${userDataDirectory}`,
        `--extensions-dir=${extensionsDirectory}`,
      ],
    });
  } finally {
    await Promise.all([
      rm(testWorkspace, { force: true, recursive: true }),
      rm(userDataDirectory, { force: true, recursive: true }),
      rm(extensionsDirectory, { force: true, recursive: true }),
    ]);
  }
}

void main().catch((error: unknown) => {
  console.error("Failed to run Smart Snippets integration tests.", error);
  process.exitCode = 1;
});
