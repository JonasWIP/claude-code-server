# Claude Code Server

Docker-basierte Entwicklungsumgebung für Claude Code CLI mit vollständiger Unterstützung für Git-Operationen, Java/Spring Boot, Python und mehr.

## Schnellstart

### 1. Konfiguration erstellen

```bash
cd ~/claude-code-server

# .env-Datei erstellen und anpassen
cp .env.example .env
chmod 600 .env

# Mindestens ANTHROPIC_API_KEY und Git-Konfiguration setzen
nano .env
```

### 2. SSH-Keys einrichten (für GitHub SSH-Zugriff)

```bash
# Bestehende SSH-Keys kopieren
cp ~/.ssh/id_ed25519 ./config/ssh/
cp ~/.ssh/id_ed25519.pub ./config/ssh/

# Oder neue Keys generieren
ssh-keygen -t ed25519 -C "your.email@example.com" -f ./config/ssh/id_ed25519

# Berechtigungen setzen
chmod 600 ./config/ssh/id_ed25519
chmod 644 ./config/ssh/id_ed25519.pub
```

### 3. Container bauen und starten

```bash
# Container bauen
docker compose build

# Container starten
docker compose up -d

# Logs prüfen
docker compose logs -f
```

### 4. Claude Code verwenden

```bash
# Interaktive Claude-Session starten
docker exec -it claude-code-server claude

# Oder direkt einen Task ausführen
docker exec -it claude-code-server /scripts/run-task.sh \
  --repo "git@github.com:user/repo.git" \
  --task "Implementiere Feature X"
```

## Verzeichnisstruktur

```
~/claude-code-server/
├── docker-compose.yml      # Docker Compose Konfiguration
├── Dockerfile              # Container-Definition
├── .env                    # Environment-Variablen (nicht im Git!)
├── .env.example            # Vorlage für .env
├── config/
│   └── ssh/                # SSH-Keys für GitHub
│       ├── id_ed25519      # Privater Schlüssel
│       └── id_ed25519.pub  # Öffentlicher Schlüssel
├── workspace/              # Geclonte Repositories
│   └── .logs/              # Task-Logs
├── scripts/
│   ├── entrypoint.sh       # Container-Startscript
│   ├── run-task.sh         # Task-Runner
│   └── setup-git.sh        # Git-Konfigurationshilfe
└── README.md               # Diese Dokumentation
```

## Konfiguration

### Environment-Variablen (.env)

| Variable | Beschreibung | Erforderlich |
|----------|--------------|--------------|
| `ANTHROPIC_API_KEY` | Anthropic API-Schlüssel | Ja |
| `GIT_USER_NAME` | Git Commit-Autor Name | Ja |
| `GIT_USER_EMAIL` | Git Commit-Autor E-Mail | Ja |
| `GITHUB_TOKEN` | GitHub Personal Access Token | Nein |
| `GIT_DEFAULT_BRANCH` | Standard-Branch (default: main) | Nein |
| `TZ` | Zeitzone (default: Europe/Berlin) | Nein |

### SSH-Keys für GitHub

1. **Bestehende Keys verwenden:**
   ```bash
   cp ~/.ssh/id_ed25519* ./config/ssh/
   ```

2. **Neue Keys generieren:**
   ```bash
   ssh-keygen -t ed25519 -C "your.email@example.com" -f ./config/ssh/id_ed25519
   ```

3. **Public Key zu GitHub hinzufügen:**
   - Kopiere den Inhalt von `./config/ssh/id_ed25519.pub`
   - Füge ihn unter https://github.com/settings/keys hinzu

## Verwendung

### Interaktive Session

```bash
# Claude Code interaktiv starten
docker exec -it claude-code-server claude

# Bash-Shell im Container
docker exec -it claude-code-server bash
```

### Task Runner

Der Task Runner klont automatisch Repositories und führt Claude-Aufgaben aus:

```bash
# Einfacher Task
docker exec claude-code-server /scripts/run-task.sh \
  --repo "git@github.com:user/repo.git" \
  --task "Fix the login bug in auth.js"

# Mit neuem Branch
docker exec claude-code-server /scripts/run-task.sh \
  --repo "git@github.com:user/repo.git" \
  --task "Implement user dashboard" \
  --branch "feature/dashboard" \
  --create-branch

# In Subdirectory arbeiten
docker exec claude-code-server /scripts/run-task.sh \
  --repo "git@github.com:user/repo.git" \
  --task "Update API documentation" \
  --path "docs/api"

# Dry-Run (zeigt nur was passieren würde)
docker exec claude-code-server /scripts/run-task.sh \
  --repo "git@github.com:user/repo.git" \
  --task "Test task" \
  --dry-run
```

### Task Runner Optionen

| Option | Beschreibung |
|--------|--------------|
| `-r, --repo URL` | Git Repository URL (erforderlich) |
| `-t, --task TASK` | Aufgabenbeschreibung (erforderlich) |
| `-b, --branch BRANCH` | Branch-Name (default: main) |
| `-p, --path PATH` | Subdirectory im Repository |
| `-c, --create-branch` | Neuen Branch erstellen |
| `-m, --model MODEL` | Claude-Modell auswählen |
| `-d, --dry-run` | Nur simulieren |
| `-v, --verbose` | Ausführliche Ausgabe |
| `-h, --help` | Hilfe anzeigen |

### Git-Operationen

```bash
# Repository manuell klonen
docker exec -it claude-code-server git clone git@github.com:user/repo.git /home/claude/workspace/repo

# Im Repository arbeiten
docker exec -it claude-code-server bash -c "cd /home/claude/workspace/repo && git status"

# Änderungen committen und pushen
docker exec -it claude-code-server bash -c "
  cd /home/claude/workspace/repo && \
  git add -A && \
  git commit -m 'Fix: Updated by Claude' && \
  git push
"
```

### Build-Operationen

```bash
# Maven Build
docker exec claude-code-server bash -c "cd /home/claude/workspace/java-project && mvn clean install"

# Gradle Build
docker exec claude-code-server bash -c "cd /home/claude/workspace/java-project && gradle build"

# Python Tests
docker exec claude-code-server bash -c "cd /home/claude/workspace/python-project && python -m pytest"

# Node.js
docker exec claude-code-server bash -c "cd /home/claude/workspace/node-project && npm install && npm test"
```

## Management

### Container-Status

```bash
# Status prüfen
docker compose ps

# Logs anzeigen
docker compose logs -f claude-code

# Health-Check
docker exec claude-code-server claude --version
```

### Container neu starten

```bash
# Stoppen
docker compose down

# Neu starten
docker compose up -d

# Mit Rebuild
docker compose up -d --build
```

### Aufräumen

```bash
# Container stoppen und entfernen
docker compose down

# Inklusive Volumes (löscht Caches!)
docker compose down -v

# Image entfernen
docker rmi claude-code-server-claude-code
```

## Troubleshooting

### Problem: SSH-Authentifizierung fehlgeschlagen

```bash
# SSH-Verbindung testen
docker exec claude-code-server ssh -T git@github.com

# SSH-Agent im Container prüfen
docker exec claude-code-server ssh-add -l

# Known hosts prüfen
docker exec claude-code-server cat /tmp/.ssh/known_hosts
```

### Problem: API-Key funktioniert nicht

```bash
# Environment-Variable prüfen
docker exec claude-code-server printenv ANTHROPIC_API_KEY

# Claude direkt testen
docker exec -it claude-code-server claude --version
```

### Problem: Git-Commits fehlerhaft

```bash
# Git-Konfiguration prüfen
docker exec claude-code-server git config --global --list

# Neu konfigurieren
docker exec -it claude-code-server /scripts/setup-git.sh
```

### Problem: Container startet nicht

```bash
# Build-Logs prüfen
docker compose build --no-cache 2>&1 | tee build.log

# Container manuell starten für Debug
docker run -it --rm \
  --env-file .env \
  -v $(pwd)/workspace:/home/claude/workspace \
  claude-code-server-claude-code bash
```

### Problem: Berechtigungen

```bash
# Workspace-Berechtigungen korrigieren (Host)
sudo chown -R 1000:1000 ./workspace

# Im Container
docker exec claude-code-server id
# Sollte uid=1000(claude) gid=1000(claude) anzeigen
```

## Installierte Tools

| Tool | Version | Beschreibung |
|------|---------|--------------|
| Claude Code | Latest | Anthropic CLI |
| Node.js | 20 LTS | JavaScript Runtime |
| Python | 3.12 | Python Interpreter |
| Java | 21 (Temurin) | JDK |
| Maven | 3.9.x | Java Build Tool |
| Gradle | 8.5 | Java Build Tool |
| Git | Latest | Version Control |
| GitHub CLI | Latest | GitHub CLI (gh) |
| Docker CLI | Latest | Docker Client |

## Sicherheitshinweise

- `.env`-Datei niemals committen (ist in .gitignore)
- SSH-Keys mit `chmod 600` schützen
- API-Keys regelmäßig rotieren
- Container läuft als non-root User (claude, UID 1000)
- SSH-Keys werden read-only gemountet
- `no-new-privileges` Security-Option aktiviert

## Lizenz

Dieses Setup ist für den persönlichen Gebrauch bestimmt. Claude Code unterliegt den [Anthropic Nutzungsbedingungen](https://www.anthropic.com/terms).
