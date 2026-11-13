For every ticket that changes UI, the PR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI PR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.
Never enable auto-merge as the agent account, so the agent does not merge its own work.
For now a person merges every PR: do not enable auto-merge in this phase, and say in your report that a person merges it.
If auto-merge was enabled earlier, withdraw it with `<merge CLI> pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` before any further push; keep this withdrawal instruction even though this phase does not enable auto-merge.
When the contract, the assignment, these prompts or repository instructions configure approvers, waiting for those approvals is a waiting state: report that you are waiting and do not retry `orchestrator_report(state="ready")` while an approval is still missing. A ready report that the verifier answers with `ready.awaiting-approval` means wait for the person; do not resend it in a loop.
Never approve or merge on behalf of a reviewer.

Treat review feedback as new work on top of the reviewed head: add one or more new candidate commits and run the required `hephi_check` checks again after those commits, because a source change invalidates earlier check evidence.
Never rewrite reviewed commit history: do not use `git filter-branch`, rebase, amend, squash or force-push over commits that were already pushed and reviewed; review and approval bind to those commits, so later changes must be additive commits.
Credit each person who reviews a PR you opened once per PR in `orchestrator_report`; do not rewrite commits to add trailers. Record whom you credited there so a later worker does not credit them again.
Do not credit bots (logins ending in [bot] and the accounts these instructions name as review bots), the PR's author, the agent account, or the person these instructions name as commit author, who is already the author of every commit.
If the PR has merged, do not rewrite it; record any uncredited reviewer in `orchestrator_report`.
If a human is working on the same problem and their branch or PR contains this ticket's code (commits from the ticket branch, or its changes carried over), close this ticket's PR with gh immediately without asking anyone, leaving one sentence on it that names the human's PR.
Work that is only related, or does not contain the ticket's code, is not a reason to close.
Closing the PR ends the ticket; send no other message.
