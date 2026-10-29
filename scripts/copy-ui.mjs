// The UI is plain HTML/CSS/JS (no build step): copy it next to the compiled server.
import { cpSync, mkdirSync } from 'node:fs'
mkdirSync('dist/ui', { recursive: true })
cpSync('src/ui', 'dist/ui', { recursive: true })
