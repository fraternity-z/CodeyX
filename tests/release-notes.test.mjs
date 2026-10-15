import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseReleaseNotes, readReleaseNotes, releaseNotesFile } from "../scripts/release-notes.mjs";

const body = "本次更新让更新公告更易阅读。\n\n## 本次亮点\n\n支持 **完整公告**、截图和表格。\n\n<details>\n<summary>完整变更</summary>\n\n- 保留详细说明。\n\n</details>";
const announcement = `# CodeyX v1.2.6 · 更清楚的更新公告\n\n${body}\n`;

test("版本公告的首行作为发布标题，正文完整保留 Markdown", () => {
  assert.deepEqual(parseReleaseNotes(announcement, "1.2.6"), {
    name: "CodeyX v1.2.6 · 更清楚的更新公告",
    body: `${body}\n`,
  });
  assert.deepEqual(parseReleaseNotes(`\uFEFF${announcement.replaceAll("\n", "\r\n")}`, "1.2.6"), parseReleaseNotes(announcement, "1.2.6"));
});

test("生成 Release 正文时保留代码缩进和 Markdown 硬换行", () => {
  const content = "    const value = 1;\n\n第一行  \n第二行  ";
  assert.equal(parseReleaseNotes(`# CodeyX v1.2.6 · 排版\n\n${content}\n`, "1.2.6").body, `${content}\n`);
});

test("正式版和实验版各自读取与版本完全一致的公告", () => {
  assert.equal(releaseNotesFile("1.2.6"), "releases/v1.2.6.md");
  assert.equal(releaseNotesFile("1.2.6-beta.1"), "releases/v1.2.6-beta.1.md");
  assert.equal(parseReleaseNotes(announcement.replace("v1.2.6", "v1.2.6-beta.1"), "1.2.6-beta.1").body, `${body}\n`);
  for (const version of ["../1.2.6", "v1.2.6", "1.2.6\n", "1.2.6+local"]) assert.throws(() => releaseNotesFile(version));
});

test("缺失、空白、版本错位和未填写的模板不能发布", () => {
  for (const source of ["", " \n", "# CodeyX v1.2.6 · 只有标题", announcement.replace("v1.2.6", "v1.2.5"), announcement.replace("更清楚的更新公告", "{{版本主题}}"), announcement.replace(body, "{{更新摘要}}"), `# CodeyX v1.2.6 · 标题\u0000\n\n正文`]) {
    assert.throws(() => parseReleaseNotes(source, "1.2.6"), /公告|标题|模板|版本|正文/);
  }
  assert.throws(() => parseReleaseNotes(`${announcement}${"内容".repeat(70_000)}`, "1.2.6"), /过长/);
  const template = readFileSync(new URL("../releases/TEMPLATE.md", import.meta.url), "utf8");
  assert.throws(() => parseReleaseNotes(template.replaceAll("{{版本号}}", "1.2.6"), "1.2.6"), /模板/);
});

test("已填写的正文可以包含代码示例，不能误判为模板占位符", () => {
  const source = `${announcement}\n\`\`\`yaml\nvalue: \${{ github.ref_name }}\n\`\`\`\n`;
  assert.match(parseReleaseNotes(source, "1.2.6").body, /github\.ref_name/);
});

test("公告文件缺失时给出确切路径，不回退到空白或自动生成的内容", t => {
  const root = mkdtempSync(join(tmpdir(), "codeyx-release-notes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => readReleaseNotes("1.2.6", root), /releases\/v1\.2\.6\.md/);
  mkdirSync(join(root, "releases"));
  writeFileSync(join(root, releaseNotesFile("1.2.6")), announcement);
  assert.deepEqual(readReleaseNotes("1.2.6", root), {
    file: "releases/v1.2.6.md",
    ...parseReleaseNotes(announcement, "1.2.6"),
  });
});
