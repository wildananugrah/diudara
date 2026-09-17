git checkout main
git pull --ff-only

git merge --ff-only [another-branch-name]
git merge --ff-only docs/deployment-runbook

git push origin main

git branch -d [another-branch-name]
git branch -d docs/deployment-runbook