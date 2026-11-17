@echo off
chcp 65001 >nul
title burnit.chat Relay
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-relay.ps1"
if errorlevel 1 pause
