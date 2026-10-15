import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseIdentity } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const placeholder = /\{\{(?:版本号|版本主题|更新摘要|亮点标题|亮点说明|优化与修复|升级须知|完整变更链接)\}\}/;

export function releaseNotesFile(version) {
  return `releases/${releaseIdentity(version).tag}.md`;
}

export function parseReleaseNotes(source, version) {
  const { tag } = releaseIdentity(version);
  if (typeof source !== "string" || !source.trim()) throw new Error(`${tag} 的更新公告不能为空`);
  if (Buffer.byteLength(source, "utf8") > 120_000) throw new Error(`${tag} 的更新公告过长`);
  const markdown = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replace(/^\n+/, "");
  if (placeholder.test(markdown)) throw new Error(`${tag} 的公告模板尚未填写完成`);
  const [heading, ...lines] = markdown.split("\n");
  const prefix = `# CodeyX ${tag} · `;
  if (!heading.startsWith(prefix) || !heading.slice(prefix.length).trim() || heading.length > 160 || /[\u0000-\u001f\u007f]/.test(heading)) {
    throw new Error(`公告标题必须为「${prefix}版本主题」，且与发布版本一致`);
  }
  const body = lines.join("\n").replace(/^\n+|\n+$/g, "");
  if (!body.trim()) throw new Error(`${tag} 的公告正文不能为空`);
  return { name: heading.slice(2).trim(), body: `${body}\n` };
}

export function readReleaseNotes(version, directory = root) {
  const file = releaseNotesFile(version);
  let source;
  try {
    source = readFileSync(join(directory, file), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`缺少更新公告 ${file}，请根据 releases/TEMPLATE.md 编写并审核后再发布`);
  }
  return { file, ...parseReleaseNotes(source, version) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/release-notes.mjs <version>");
    const notes = readReleaseNotes(process.argv[2].replace(/^v/i, ""));
    console.log(`已校验 ${notes.file}：${notes.name}`);
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    process.exitCode = 1;
  }
}
