# Presentation Studio beta deployment

Isolated review/beta hosting for treisland/presentation-studio issue #130.

Only trusted workflows run here. They verify an approved published beta/RC release or successful same-repository owner-PR CI artifact, then deploy only allowlisted static files with matching hashes. No presentation data is stored by this repository. Reviews are development builds awaiting manual acceptance; they are not releases.

Enable Pages with GitHub Actions and restrict the github-pages environment to main. Keep the GitHub URL until domain verification/DNS are complete. Source documentation: https://github.com/treisland/presentation-studio/blob/codex/distribution-deployment/docs/deployment.md
Review mode requires an unchanged CI ZIP staged as review/review-site.zip through a reviewed commit in this repository. Its SHA256 must equal the source CI artifact. The maintainer stages with existing local gh authentication; CI stays read-only and downloads the immutable transfer commit anonymously. No source credential, draft release or transfer tag is needed. Supply transfer_commit along with the source run/head.

