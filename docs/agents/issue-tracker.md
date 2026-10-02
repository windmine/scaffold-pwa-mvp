# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues for `windmine/scaffold-pwa-mvp`. Use the `gh` CLI from this checkout and verify the repository against `git remote -v`.

## Conventions

- Read a ticket with `gh issue view <number> --comments` and fetch its labels.
- List relevant tickets with `gh issue list --state open --json number,title,body,labels,comments`, using appropriate label/state filters.
- When explicitly asked to publish a plan or issue, use `gh issue create --title "..." --body-file <prepared-file>`.
- Comment with `gh issue comment <number> --body-file <prepared-file>`.
- Apply/remove configured labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue with `gh issue close <number> --comment "..."` when the requested workflow authorizes it.

"Publish to the issue tracker" means create a GitHub issue; "fetch the relevant ticket" means read it with comments. Ordinary local implementation, diagnosis or repository setup does not itself authorize creating issues, labels, comments or pull requests.
