import path from "node:path";

export async function run(): Promise<void> {
  const { default: Mocha } = await import("mocha");
  const mocha = new Mocha({
    color: true,
    timeout: 20_000,
    ui: "tdd",
  });
  mocha.addFile(path.resolve(__dirname, "smartSnippets.test.js"));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} Smart Snippets integration test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
