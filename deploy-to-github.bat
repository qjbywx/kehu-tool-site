@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed or not in PATH.
  echo Install from https://git-scm.com then run this again.
  pause
  exit /b 1
)

git branch -M main >nul 2>&1

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  set /p REPO="Enter your GitHub repo URL (e.g. https://github.com/username/repo.git): "
  if "!REPO!"=="" (
    echo No URL entered. Aborted.
    pause
    exit /b 1
  )
  git remote add origin "!REPO!"
  if errorlevel 1 (
    echo Failed to add remote.
    pause
    exit /b 1
  )
) else (
  echo Remote already set. Pushing to existing origin.
)

git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed. Check the URL, or sign in to GitHub when prompted.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo Done! One last one-time step on github.com:
echo   Repo - Settings - Pages - Source: GitHub Actions
echo Then open: https://USERNAME.github.io/REPO/
echo ============================================================
pause
