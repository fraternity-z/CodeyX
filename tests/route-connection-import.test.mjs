import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const { importNewApiConnection } = createModuleGraph(new URL("../src/features/routes/connectionImport.ts", import.meta.url)).exports;
const { createRouteDraft } = createModuleGraph(new URL("../src/features/routes/draft.ts", import.meta.url)).exports;
const connection = (patch = {}) => JSON.stringify({ _type: "newapi_channel_conn", key: " fixture-key ", url: " https://api.demo.test/v1 ", ...patch });

test("New API 导入仅填充连接字段和空名称，保留协议及用户草稿", () => {
  const draft = createRouteDraft("new");
  const imported = importNewApiConnection(`连接信息：\n${connection()}\n`, draft);
  assert.deepEqual(imported, { baseUrl: "https://api.demo.test/v1", apiKey: "fixture-key", clearApiKey: false, name: "api.demo.test", shortName: "demo" });
  assert.equal(draft.apiKey, "");
  const existing = { ...draft, name: "自定义", shortName: "自", upstreamProtocol: "gemini" };
  assert.deepEqual({ ...existing, ...importNewApiConnection(connection(), existing) }, { ...existing, baseUrl: "https://api.demo.test/v1", apiKey: "fixture-key" });
  assert.equal(importNewApiConnection(connection({ url: "https://a-very-long-domain.example.test" }), draft).name, "");
});

test("New API 拒绝错误格式、空密钥、危险地址和超长输入，不回显输入", () => {
  const draft = createRouteDraft("new");
  for (const text of ["", "null", "[]", "invalid", connection({ _type: "other" }), connection({ key: " " }), connection({ key: 1 }), connection({ url: "file:///secret" }), connection({ url: "https://user:password@example.test" }), "x".repeat(65537)]) {
    assert.throws(() => importNewApiConnection(text, draft), error => {
      assert.doesNotMatch(error.message, /fixture-key|password|secret/);
      return true;
    });
  }
});
