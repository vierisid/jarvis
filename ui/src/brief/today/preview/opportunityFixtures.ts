import type { OpportunityBinding, OpportunityCard, OpportunityRequest, OpportunityResult } from "../opportunity-stack/model";

/** Approved UI-16 copy. IDs and outcomes are isolated examples, never live fallbacks. */
export function opportunityCards(): OpportunityCard[] {
  return [
    { title: "Call prep, ready to run.", observation: "Emails and notes searched before 4 sales calls.", automation: "Context and questions, ready before every call.", goalTitle: "Win 10 design partners", rationale: "Know what each prospect needs to say yes." },
    { title: "Your competitor brief is ready.", observation: "The same 3 sites, 3 Tuesdays in a row.", automation: "Read 3 sites → compare → save a weekly brief.", goalTitle: "Win 10 design partners", rationale: "Answer ‘why Jarvis?’ on your next pilot call." },
    { title: "Your Friday update, prepared.", observation: "The same Friday investor update routine.", automation: "Gather progress → draft your weekly update.", goalTitle: "Keep investors informed", rationale: "Share your progress every week." },
  ].map((copy, index) => ({ ...copy, proposal: {
    proposalId: `fixture-opportunity-${index}`, revision: "v1", state: "ready", readiness: { state: "ready", checkedAt: Date.now() },
    evidence: [{kind:"observation", id:`fixture-observation-${index}`, revision:"v1"}],
    goal: { goalId: index === 2 ? "fixture-investors" : "fixture-design-partners", revision:"v1", rationale:copy.rationale },
    compositionId:`fixture-composition-${index}`, workflow: { flowId:`fixture-flow-${index}`, versionId:`fixture-version-${index}`, activation:"DISABLED", versionState:"DRAFT" },
    bindings:[{kind:"connection",id:"fixture-account",revision:"v1",availability:"ready"}], previewBasis:"illustrative_template",
  } }));
}
export function opportunityFixture(scenario = "ready"): OpportunityBinding {
  const data = opportunityCards();
  const binding: OpportunityBinding = { scopeKey: "fixture-workspace", source: "fixture", state: {status:"ready", data} };
  if (scenario === "loading" || scenario === "empty") binding.state = {status:scenario};
  if (scenario === "unavailable" || scenario === "unsupported") binding.state = {status:scenario, reason:"Prepared opportunities are not available yet."};
  if (scenario === "stale") binding.state = {status:"stale", data, reason:"Refresh the prepared proposals."};
  if (scenario === "preparing" || scenario === "blocked") data[0]!.proposal = {...data[0]!.proposal, state:scenario,readiness:{state:scenario === "preparing" ? "unchecked":"blocked",checkedAt:null}};
  if (scenario === "blocked" || scenario === "missing-connection") {
    data[0]!.preparationReason = "Connect the required Gmail account before enabling.";
    data[0]!.proposal.bindings[0]!.availability = "unavailable";
  }
  if (scenario === "long") {
    data[0]!.observation = `${data[0]!.observation} ${data[0]!.observation} ${data[0]!.observation}`;
    data[0]!.automation = `${data[0]!.automation} ${data[0]!.automation}`;
    data[0]!.goalTitle = "Win 10 design partners across the European enterprise pilot programme";
  }
  return binding;
}
export function opportunityReceipt(request: OpportunityRequest): OpportunityResult {
  return {...request,state:"confirmed",receiptId:`fixture-${request.requestId}`,outcome:request.action === "approve_enable" ? "enabled":"dismissed"};
}
