# Wikey Wallet Skill

## Git Flow

Feature branches base off `origin/beta`. Merge target is `origin/beta`. `main` is updated separately via beta → main merge.

```bash
# 1. Create branch from beta
git checkout -b <type>/<short-desc> origin/beta

# 2. Commit 
git add <files>
git commit -m "<type>(<scope>): <subject>

<body>"

# 3. Push branch
git push -u origin <type>/<short-desc>

# 4. Rebase onto latest beta
git fetch origin
git rebase origin/beta
git push --force-with-lease origin <type>/<short-desc>   # only if rebase moved HEAD

# 5. Merge to beta
git checkout beta
git pull origin beta
git merge --no-ff <type>/<short-desc>
git push origin beta
```

Branch naming follows conventional commits prefix: `fix/`, `feat/`, `chore/`, etc.
