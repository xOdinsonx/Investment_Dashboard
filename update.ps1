# update.ps1
# Run this from inside the Investment_Dashboard folder any time you've
# dropped in new file versions. It pulls the latest (so bot commits like
# data.json never cause a rejected push), then commits and pushes your
# changes, all in the right order.
#
# Usage:
#   .\update.ps1
#   .\update.ps1 -Message "Add analyst data"

param(
    [string]$Message = "Update dashboard"
)

Write-Host "== Pulling latest changes ==" -ForegroundColor Cyan
git pull --no-edit
if ($LASTEXITCODE -ne 0) {
    Write-Host "git pull failed -- resolve any conflicts shown above before continuing." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "== Staging changes ==" -ForegroundColor Cyan
git add .

$status = git status --porcelain
if (-not $status) {
    Write-Host "Nothing to commit -- files are unchanged since last push." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "== Committing ==" -ForegroundColor Cyan
git commit -m "$Message"

Write-Host ""
Write-Host "== Pushing ==" -ForegroundColor Cyan
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "git push failed -- see the error above." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Done. GitHub Pages will redeploy within about a minute." -ForegroundColor Green