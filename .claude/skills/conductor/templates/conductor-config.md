# Conductor config: <project>

Project-specific settings for the conductor, worker, steward and reviewer. Keep it under
~150 lines. Facts a WORKER needs go in `tasks/briefs/_core-context.md` instead.

## Owner and approval
- Owner: <name>. How they like reports and options:
- Ship gate: the exact phrase that allows a merge to `main`/production:
- Batch plans: one message per batch; may the owner waive the wait?

## Where work comes from
- <audit doc, issue tracker, project-state section>

## Commands
- Fresh clone:      Checks:      Build:
- CI:

## Protected files (conductor-only)
- <shared types, config, deploy files, migrations>

## Serialized modules (never two open workers at once)
- <the hub module>

## Merge order on the integration branch
1. Conductor shared-infra commits. 2. Leaf modules. 3. Hub modules last.

## Migrations / shared resources
- How numbers are reserved, how they are applied, how to verify by name.

## Ship checklist (after approval; verify each step before the next)
1. Before-deploy steps. 2. Deploy ready (check the deployment, not the merge).
3. After-deploy steps. 4. External prerequisites. 5. First prod run of anything scheduled.
6. Write the verified state to `tasks/project-state.md`. 7. Merge `main` back into integration.

## Batch audit model
## Cost and volume rules
## Environment (prod data, brain, secrets: where they live, never their values)
