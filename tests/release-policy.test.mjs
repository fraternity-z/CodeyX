import test from "node:test";
import assert from "node:assert/strict";
import { compareReleaseVersions, releaseIdentity, resolveReleaseVersion } from "../scripts/release-policy.mjs";

test("实验版后缀只生成一次，定向推送不改变身份", () => {
  assert.deepEqual(resolveReleaseVersion("1.0.0", "stable"), { version: "1.0.0", tag: "v1.0.0", channel: "stable", prerelease: false, name: "正式版 v1.0.0" });
  const beta = resolveReleaseVersion("1.0.0", "experimental");
  assert.equal(beta.version, "1.0.0-beta.1");
  assert.equal(beta.tag, "v1.0.0-beta.1");
  assert.equal(beta.prerelease, true);
  assert.deepEqual(resolveReleaseVersion(beta.version, "experimental"), beta);
  assert.equal(releaseIdentity("1.0.0-rc.2").channel, "experimental");
  assert.throws(() => resolveReleaseVersion(beta.version, "stable"));
  assert.throws(() => resolveReleaseVersion("1.0.0", "targeted"));
});

test("SemVer 正确比较测试序号、正式版和旧测试标识", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-beta.1", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0-rc.1", "1.0.0", "1.0.1-beta.1"];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareReleaseVersions(ordered[index - 1], ordered[index]), -1);
    assert.equal(compareReleaseVersions(ordered[index], ordered[index - 1]), 1);
  }
  assert.equal(compareReleaseVersions("1.0.0-test-one", "1.0.0-test-two"), -1);
  for (const invalid of ["v1.0.0", "01.0.0", "1.0.0-beta.01", "1.0.0+build", "1.0.0\n"]) assert.throws(() => releaseIdentity(invalid));
});
