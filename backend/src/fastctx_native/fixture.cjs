const readline = require("node:readline");
const calls = new Map();
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "tools/list") return send(id, { tools: [{ name: "fixture" }] });
  if (method === "cancel") {
    const pending = calls.get(params.requestId);
    if (pending) {
      clearTimeout(pending);
      calls.delete(params.requestId);
      send(params.requestId, { content: [{ type: "text", text: "cancelled" }], isError: true });
    }
    return send(id, { requestId: params.requestId, status: pending ? "cancellationRequested" : "notRunning" });
  }
  if (params.arguments.exit) return process.exit(7);
  if (params.arguments.maxInFlight && calls.size >= params.arguments.maxInFlight) {
    return send(id, { content: [{ type: "text", text: "fixture in-flight limit reached" }], isError: true });
  }
  const finish = () => {
    calls.delete(id);
    send(id, { content: [{ type: "text", text: process.cwd() }], isError: false });
  };
  calls.set(id, setTimeout(finish, params.arguments.delay || 0));
});
