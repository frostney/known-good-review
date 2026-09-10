import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Proves the compiled Eve server can stream a routed root-copy child through production instrumentation.",
  tags: ["mock-model", "runtime-smoke"],
  async test(t) {
    let turn = await t.send("KGR-EVAL-SUBAGENT-ROUTING");
    if (!t.sessionId) throw new Error("Expected a root session");
    // Delegation returns a working receipt in Eve 0.52. Continue reading the
    // real session stream until the child result wakes and completes the root.
    let cursor = turn.events.length;
    const parentEvents = [...turn.events];
    while (turn.message !== "SUBAGENT-ROUTING-COMPLETE") {
      turn = await t.target.watchTurn(t.sessionId, { startIndex: cursor }).result();
      cursor += turn.events.length;
      parentEvents.push(...turn.events);
    }

    const delegated = parentEvents.find((event) => event.type === "subagent.called");
    if (!delegated) throw new Error("Expected a delegated child session");
    const child = await t.target.attachSession(delegated.data.childSessionId);
    child.succeeded();
    child.calledTool("fixture_step", { count: 1, input: { marker: "routing" } });
    child.messageIncludes("SUBAGENT-CHILD-COMPLETE");

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("agent", {
      count: 1,
    });
    t.eventOrder([
      { type: "subagent.called", data: { childSessionId: delegated.data.childSessionId }, count: 1 },
      { type: "message.received", data: { message: /Result:\nSUBAGENT-CHILD-COMPLETE/ }, count: 1 },
      { type: "message.completed", data: { message: "SUBAGENT-ROUTING-COMPLETE" }, count: 1 },
    ]);
    t.messageIncludes("SUBAGENT-ROUTING-COMPLETE");

    // The waiting Workflow must finish its child before the same parent turn
    // returns. This also proves Eve builds and executes without an app SDK pin.
    const workflowTurn = await t.send("KGR-EVAL-WORKFLOW-ROUTING");
    workflowTurn.expectOk();
    t.calledTool("fixture_workflow", { count: 1 });
    t.messageIncludes("WORKFLOW-ROUTING-COMPLETE");
    t.noFailedActions();
    const workflowDelegation = workflowTurn.events.find((event) => event.type === "subagent.called");
    if (!workflowDelegation) throw new Error("Expected a Workflow child session");
    const workflowChild = await t.target.attachSession(workflowDelegation.data.childSessionId);
    workflowChild.succeeded();
    workflowChild.calledTool("fixture_step", { count: 1, input: { marker: "routing" } });
    workflowChild.messageIncludes("SUBAGENT-CHILD-COMPLETE");
  },
});
