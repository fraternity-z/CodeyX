import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const { sessionPath } = await loadTypeScriptModule(new URL("../src/features/session-management/state.ts", import.meta.url));

test("session paths hide Windows extended prefixes without changing the path text", () => {
  assert.equal(sessionPath("\\\\?\\E:\\code\\MyProject"), "E:\\code\\MyProject");
  assert.equal(sessionPath("\\\\?\\UNC\\Server\\Share\\MyProject"), "\\\\Server\\Share\\MyProject");
  assert.equal(sessionPath("\\\\?\\unc\\Server\\Share"), "\\\\Server\\Share");
  for (const path of ["E:\\code\\MyProject", "e:/code/MyProject", "\\\\Server\\Share", "/work/MyProject", "", "folder\\\\?\\name"]) {
    assert.equal(sessionPath(path), path);
  }
});
