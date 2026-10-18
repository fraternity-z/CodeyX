import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const featureOf = (file) => /^src\/features\/([^/]+)\//.exec(file)?.[1];
const layerOf = (file) => {
  const name = path.posix.basename(file);
  if (name === "index.ts") return "entry";
  if (name === "requests.ts") return "requests";
  if (/^use.*Controller\.ts$/.test(name)) return "controller";
  if (name.endsWith(".tsx")) return "view";
  return "pure";
};

export function checkArchitecture(sources) {
  const errors = [];
  const edges = new Map();
  const report = (file, node, tree, message) => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    errors.push(`${file}:${line}: ${message}`);
  };
  for (const [file, source] of Object.entries(sources)) {
    const feature = featureOf(file);
    const governed = !!feature;
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const layer = layerOf(file);
    const dependencies = [];
    edges.set(file, dependencies);
    const checkImport = (node, specifier, typeOnly = false) => {
      if (typeof specifier !== "string" || typeOnly) return;
      const target = (specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier)
        .replace(/\.jsx?$/, (extension) => extension === ".jsx" ? ".tsx" : ".ts");
      const resolved = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].find((candidate) => candidate in sources);
      if (resolved) dependencies.push(resolved);
      const targetFeature = featureOf(`${target}/`);
      if (targetFeature && targetFeature !== feature
        && !/^src\/features\/[^/]+(?:\/index(?:\.ts)?)?$/.test(target)) {
        report(file, node, tree, "跨功能只能使用公开入口，不能导入内部文件");
      }
      if (file === "src/App.tsx" && /^src\/api(?:\.ts)?$/.test(target)) {
        report(file, node, tree, "App 不得直接依赖后端传输，请调用功能 controller");
      }
      if (!governed) return;
      const requestDependency = /(?:^|\/)(?:api|requests|[^/]*Requests)(?:\.ts)?$/.test(target)
        || /^src\/remote\/transport(?:\.ts)?$/.test(target);
      if (layer === "view" && requestDependency) report(file, node, tree, "视图不能依赖请求层");
      if (layer === "controller" && requestDependency && target !== `src/features/${feature}/requests` && target !== `src/features/${feature}/requests.ts`) {
        report(file, node, tree, "controller 必须经本功能 requests 调用后端");
      }
      if (layer === "controller" && (target.endsWith(".tsx") || (resolved && layerOf(resolved) === "view"))) {
        report(file, node, tree, "controller 不能依赖视图实现");
      }
      if (["pure", "requests"].includes(layer) && (specifier === "react" || /(?:Controller|View|Page|Dialog)(?:\.tsx?)?$/.test(target) || (resolved && layerOf(resolved) === "view"))) {
        report(file, node, tree, "纯逻辑与请求层不能依赖 React、controller 或视图");
      }
      if (layer === "pure" && requestDependency) report(file, node, tree, "纯逻辑不能依赖请求层");
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        const bindings = clause?.namedBindings;
        const allNamedTypes = !clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly);
        const exports = ts.isExportDeclaration(node) ? node.exportClause : undefined;
        const allExportedTypes = exports && ts.isNamedExports(exports) && exports.elements.length > 0 && exports.elements.every((item) => item.isTypeOnly);
        checkImport(node, node.moduleSpecifier.text, node.isTypeOnly || clause?.isTypeOnly || allNamedTypes || allExportedTypes);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = node.moduleReference.expression;
        if (specifier && ts.isStringLiteral(specifier)) checkImport(node, specifier.text, node.isTypeOnly);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(tree);
        const specifier = node.arguments[0];
        if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || callee === "require") && specifier && ts.isStringLiteralLike(specifier)) checkImport(node, specifier.text);
        if (governed && layer !== "requests" && /^(?:(?:invoke|fetch|remoteRequest)|\w+\.(?:invoke|fetch|remoteRequest))$/.test(callee)) report(file, node, tree, "后端与网络调用必须进入请求层");
        if (file === "src/App.tsx" && /^(?:invoke|fetch|\w+\.(?:invoke|fetch))$/.test(callee)) {
          report(file, node, tree, "App 不得新增业务命令，请放入功能请求层");
        }
      }
      if (governed && layer !== "requests" && ts.isNewExpression(node)
        && /^(?:WebSocket|window\.WebSocket)$/.test(node.expression.getText(tree))) report(file, node, tree, "后端与网络调用必须进入请求层");
      if (governed && layer === "pure" && ts.isPropertyAccessExpression(node) && /^(?:window|document|navigator|localStorage|sessionStorage)\./.test(node.getText(tree))) report(file, node, tree, "纯逻辑不能访问浏览器副作用");
      if (governed && layer !== "view" && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) report(file, node, tree, "JSX 必须位于视图层");
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  // 检查包含功能模块的强连通分量，保留根目录历史模块自身的兼容边界。
  // 必须遍历根目录中转模块，否则转导出会隐藏环；一个分量只报告一次。
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const pending = new Set();
  const visitDependency = (file) => {
    const index = indices.size;
    indices.set(file, index);
    lowLinks.set(file, index);
    stack.push(file);
    pending.add(file);
    for (const next of edges.get(file) ?? []) {
      if (!indices.has(next)) {
        visitDependency(next);
        lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(next)));
      } else if (pending.has(next)) {
        lowLinks.set(file, Math.min(lowLinks.get(file), indices.get(next)));
      }
    }
    if (lowLinks.get(file) !== index) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      pending.delete(member);
      component.push(member);
    } while (member !== file);
    const cyclic = component.length > 1 || edges.get(file)?.includes(file);
    if (cyclic && component.some(featureOf)) errors.push(`${component.sort().join(", ")}: 运行时循环依赖`);
  };
  for (const file of edges.keys()) if (!indices.has(file)) visitDependency(file);
  return errors;
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sources = {};
  const collect = async (directory) => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else if (/\.tsx?$/.test(file)) sources[file] = await readFile(path.join(root, file), "utf8");
    }
  };
  await collect("src");
  const errors = checkArchitecture(sources);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("架构边界检查通过");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
