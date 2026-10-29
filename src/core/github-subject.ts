/**
 * GitHub's immutable OIDC subject of a repository: the `repo:OWNER@OWNER_ID/REPO@REPO_ID` prefix GitHub sends instead
 * of `repo:OWNER/REPO` for repositories created, renamed or transferred after 15 July 2026, and for those opted in
 * (its OIDC settings' "immutable subject"). The installer reads the ids from GitHub (src/installer/github.ts
 * immutableSubject); the roles trust it beside the name form (src/infra/props.ts githubSubjects). No imports: the
 * installer's page bundles it too.
 */
export const IMMUTABLE_SUBJECT = /^repo:[A-Za-z0-9-]+@\d+\/[A-Za-z0-9._-]+@\d+$/
