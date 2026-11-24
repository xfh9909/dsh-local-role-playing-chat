#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Point this repository at a GitHub remote and push main + tags.

.DESCRIPTION
  Accepts either a full URL (https://github.com/owner/repo.git, git@...,
  ssh://...) or the shorthand owner/repo. Nothing is created on GitHub here:
  create the empty repository first, then run this.

.PARAMETER Remote
  owner/repo or a full git URL.

.PARAMETER Force
  Replace an existing `origin` instead of stopping.

.EXAMPLE
  ./scripts/publish.ps1 -Remote yourname/dsh-local-role-playing-chat

.EXAMPLE
  ./scripts/publish.ps1 -Remote git@github.com:yourname/dsh-local-role-playing-chat.git
#>
param(
  [Parameter(Mandatory = $true)][string]$Remote,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# Normalize owner/repo to an https URL; leave anything with a scheme alone.
if ($Remote -match '^[a-z][a-z0-9+.-]*://' -or $Remote -match '^[^@\s]+@[^:\s]+:') {
  $url = $Remote
} else {
  $slug = $Remote.Trim().Trim('/')
  if ($slug -notmatch '^[^/\s]+/[^/\s]+$') {
    throw "远程地址不认识：'$Remote'（要 owner/repo 或完整 URL）"
  }
  $url = "https://github.com/$slug.git"
}

Write-Step "目标远程"
Write-Host $url

# Sanity: this must be the plugin repository, not the app repository.
if (-not (Test-Path './package.json') -or -not (Test-Path './cordis.patch.yml')) {
  throw '这里不像插件仓库：缺 package.json 或 cordis.patch.yml'
}
$pkg = Get-Content './package.json' -Raw | ConvertFrom-Json
if ($pkg.name -ne 'dsh-roleplay') {
  throw "package.json 的 name 是 '$($pkg.name)'，期望 dsh-roleplay"
}

$existing = git remote get-url origin 2>$null
if ($existing) {
  if (-not $Force) {
    throw "origin 已经指向 $existing。要换用 -Force。"
  }
  git remote set-url origin $url
} else {
  git remote add origin $url
}

Write-Step '提交状态'
git status --short
if (-not (git log --oneline -1 2>$null)) {
  throw '还没有任何提交，先 commit 再发布'
}

Write-Step '推送 main'
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw '推送 main 失败（检查凭据、仓库是否为空白）' }

Write-Step '推送标签'
git push origin --tags
if ($LASTEXITCODE -ne 0) { throw '推送标签失败' }

Write-Step '完成'
Write-Host "仓库：$url"
Write-Host "标签：$((git tag -l) -join ', ')"
Write-Host '提示：GitHub 上请把默认分支设为 main，并确认 Actions 已启用（.github/workflows/ci.yml）。'
