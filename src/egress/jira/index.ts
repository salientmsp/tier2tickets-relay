// Jira egress: the public surface index.ts wires up. `jiraSubscriber` is registered
// with the event spine; `flushPendingJira` is drained by the frequent cron. Everything
// here depends only on core/ — never on ingress/ (enforced by the boundary check).

export { jiraSubscriber, flushPendingJira, buildJiraIssueInput } from "./subscriber.js";
export {
  JiraClient,
  JiraError,
  adfDoc,
  jiraEnabled,
  jiraTargetFor,
  parseJiraTargets,
  type JiraIssueInput,
  type JiraTarget,
} from "./client.js";
