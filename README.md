# Code Review & Improvement System

Un système multi-agents qui relit un fichier Python : des linters trouvent les problèmes, un
**planificateur** choisit les agents utiles pour ce fichier, puis des agents LLM expliquent le code,
proposent des améliorations, écrivent la documentation et des tests, et corrigent le fichier. Les
agents **s'échangent leurs résultats** (les tests générés vérifient la correction) et le système
**se souvient** des revues précédentes. Gratuit : LLM via Hugging Face Inference Providers ou Ollama
local, linters open source.

## Démarrage rapide

```bash
pip install -r requirements.txt              # une fois
export HF_API_TOKEN=votre_cle_hugging_face   # https://huggingface.co/settings/tokens

python orchestrator.py src/sample.py         # en ligne de commande
python server.py                             # ou le tableau de bord : http://127.0.0.1:8787
```

Sans clé, les agents LLM renvoient un message d'erreur explicite ; l'analyse statique marche hors
ligne. Avec Ollama (ou tout serveur compatible OpenAI) :

```bash
ollama pull qwen2.5-coder:7b
export HF_BASE_URL=http://localhost:11434/v1 HF_API_TOKEN=ollama HF_MODEL=qwen2.5-coder:7b
```

## Comment ça marche

```
 file.py ─▶ 1. static_analysis ─▶ 2. planner ─┬─▶ code_understanding
            pylint, flake8,        choisit    ├─▶ improvement_suggestion
            bandit, radon          les agents ├─▶ documentation_agent
                                              ├─▶ test_generator ──(tests)──▶ code_correction
                                              └─────────────────────────────▶ (linters + tests)
                                  ▲
                                  └── mémoire des revues précédentes (SQLite)
```

1. **Analyse statique.** Les linters s'exécutent en premier ; leurs résultats sont transmis aux
   autres agents.
2. **Planificateur** (`agents/planner.py`). Il regarde le fichier (taille, compile-t-il, fonctions
   publiques, couverture des docstrings, fichier de tests ?), les résultats des linters et la
   mémoire, puis décide pour chaque agent : lancer ou ignorer, **avec la raison**. Exemples : fichier
   qui ne compile pas → seule la correction tourne ; fichier de tests → pas de nouveaux tests ;
   aucun problème trouvé → pas de correction ; résultat déjà approuvé sur la même version du
   fichier → pas relancé. Mode `rules` (par défaut, sans appel LLM) ou `llm`
   (`PLANNER_MODE=llm`, le modèle peut ajuster, avec règles impératives et repli sur les règles).
   S'il échoue, tous les agents tournent : un planificateur en panne ne réduit jamais une revue.
3. **Agents en parallèle** (`LLM_MAX_PARALLEL`, 5 par défaut). Un agent peut déclarer
   `depends_on` dans `orchestrator.AGENTS` (`agents/flow.py`) : la correction attend le générateur
   de tests, les autres continuent.
4. **Échange de résultats.** Les tests générés, et leur résultat sur le fichier d'origine, sont
   donnés à l'agent de correction (`CODE_REVIEW_SHARED`). Il peut les exécuter
   (`run_shared_tests`), sait lesquels échouent déjà (bugs possibles) et **une correction est
   refusée si elle casse un test qui passait**. Le détail est dans `verification.tests`
   (`regressions`, `fixed`, `still_failing`). Sans les tests (agent seul, générateur en échec,
   `CODE_REVIEW_ALLOW_EXEC=0`), les autres contrôles s'appliquent.
5. **Outils par function calling.** Le générateur de tests et la correction travaillent en boucle :
   le modèle appelle des outils (`agents/tools.py`), lit leurs résultats et corrige. Une correction
   est refusée si elle ne compile pas, supprime une fonction ou classe publique, ou a plus de
   problèmes linter que l'original. Les chiffres de `verification` viennent des outils, pas du modèle.
6. **Mémoire entre les revues** (`agents/memory.py`). Après chaque revue, `.review_memory/memory.sqlite3`
   (ignoré par git) garde les problèmes trouvés (empreintes sans numéro de ligne, donc déplacer du
   code ne les rend pas « nouveaux »), un hash du fichier, les tests qui passaient, le résultat de
   la correction et les verdicts humains. À la revue suivante : la ligne de commande affiche
   « 3 nouveaux, 5 corrigés, 2 persistants », les agents reçoivent un court historique (problèmes
   persistants prioritaires, corrigés non reproposés) et le planificateur peut ignorer un agent déjà
   approuvé. La mémoire est facultative (si elle échoue, la revue continue), désactivée en mode
   public. `python orchestrator.py --forget [fichier]` l'efface.
7. **Sorties structurées.** Chaque réponse LLM est du JSON validé par un schéma (avec repli
   `json_object` puis texte, et un aller-retour de réparation).

Les tests générés sont exécutés avec pytest dans un dossier temporaire, un processus séparé, avec
délai et sans la clé API.

## Les agents

| Agent | Rôle | Fichier |
|---|---|---|
| Static Analysis | pylint, flake8, bandit, radon | `agents/static_analysis.py` |
| Planner | choisit les agents à lancer, avec la raison | `agents/planner.py` |
| Code Understanding | explique le code, repère les parties complexes | `agents/code_understanding.py` |
| Improvement Suggestion | refactorings et bonnes pratiques | `agents/improvement_suggestion.py` |
| Documentation | docstrings, aperçu, exemple d'usage | `agents/documentation_agent.py` |
| Test Generator | écrit et exécute des tests pytest | `agents/test_generator.py` |
| Code Correction | corrige et vérifie avec les linters et les tests | `agents/code_correction_agent.py` |

Autres fichiers : `orchestrator.py` (pipeline et CLI), `agents/flow.py` (dépendances, plan),
`agents/tools.py` (outils), `agents/hf_client.py` (client LLM), `mcp_server.py`, `watcher.py`,
`server.py` + `horizon_adapter.py` (tableau de bord), `eval/run_eval.py`, `src/sample.py`
(fichier d'exemple avec des défauts).

## Utilisation

```bash
python orchestrator.py chemin/fichier.py            # une revue
python orchestrator.py --forget chemin/fichier.py   # oublier un fichier (sans argument : tout)
python watcher.py src                                # relance la revue à chaque modification
```

### Tableau de bord (Horizon AI)

`python server.py` puis ouvrir http://127.0.0.1:8787, choisir un fichier, **Start review**. Il lance
les mêmes agents que la ligne de commande et montre chaque revue en direct.

| Vue | Contenu |
|---|---|
| Results | Sortie de chaque agent ; les chiffres « checked with » viennent des outils |
| Orchestration | Le pipeline réel : analyse statique, planificateur, agents choisis en parallèle, flèche tests → correction, agents ignorés (grisés, avec la raison), chronologie |
| History | Revues passées et leurs événements |
| Statuts | En attente, en cours, terminé, échoué (erreur, délai, résultat vide) ou **ignoré** par le planificateur (non compté dans le résultat ; « Run anyway » le lance quand même) |
| Actions humaines | **Approve** (enregistré dans la mémoire) et **Re-run** |

Les revues sont stockées dans `.horizon/runs.json`. Développement du front : `cd frontend && npm
install && npm run dev`, ouvrir avec `?api=http://127.0.0.1:8787` ; `npm run build` met à jour
`frontend/dist`. Mise en ligne pour d'autres utilisateurs (chacun avec sa clé) : voir **DEPLOY.md**.

**Sécurité** : le serveur n'accepte que `localhost`, refuse les autres origines, ne relit que des
fichiers `.py` du dossier et ne sert jamais `.env`. Il n'a pas d'authentification : ne l'exposez
pas. Les agents LLM envoient le contenu du fichier à l'API configurée.

### Serveur MCP

Les mêmes outils sont utilisables depuis Claude Desktop, Claude Code, Cursor…

```bash
pip install mcp
python mcp_server.py        # transport stdio
```

```json
{"mcpServers": {"code-review": {"command": "python", "args": ["/chemin/vers/mcp_server.py"]}}}
```

Outils : `run_pylint`, `run_flake8`, `run_bandit`, `run_radon`, `check_syntax`, `run_tests`.

## Réglages (variables d'environnement)

| Variable | Défaut | Sens |
|---|---|---|
| `HF_API_TOKEN` | – | Clé Hugging Face |
| `HF_MODEL` | `openai/gpt-oss-20b:groq` | Modèle (avec function calling pour les boucles d'outils) |
| `HF_BASE_URL` | router Hugging Face | Serveur compatible OpenAI (Ollama…) |
| `HF_STRUCTURED_MODE` | `json_schema` | `json_schema`, `json_object` ou `none` |
| `PLANNER_MODE` | `rules` | `rules` ou `llm` |
| `LLM_MAX_PARALLEL` | `5` | Agents LLM simultanés |
| `AGENT_TIMEOUT` / `AGENT_TOOL_TIMEOUT` | `120` / `300` | Secondes par agent (boucles d'outils : le second) |
| `AGENT_MAX_STEPS` | `8` | Tours du modèle dans une boucle d'outils |
| `TEST_TIMEOUT` | `60` | Secondes pour une exécution de tests |
| `CODE_REVIEW_ALLOW_EXEC` | `1` | `0` désactive `run_tests` (le serveur public aussi, sauf `HORIZON_ALLOW_CODE_EXECUTION=1`) |
| `CODE_REVIEW_MEMORY_DB` | `.review_memory/memory.sqlite3` | Base de la mémoire ; `0` la désactive |
| `CODE_REVIEW_MEMORY_KEEP` | `20` | Revues gardées par fichier |

## Tests et évaluation

```bash
python -m unittest discover tests     # sans clé ni réseau, le modèle est simulé
cd frontend && node --test tests/*.test.ts

python eval/run_eval.py --fake        # vérifie le fonctionnement, sans clé
python eval/run_eval.py               # avec HF_API_TOKEN : vraies mesures de qualité
```

`eval/run_eval.py` lance le pipeline sur 20 fichiers de 5 dépôts publics (requests, click,
itsdangerous, httpie, tqdm) et mesure avec des outils : succès et validité par agent, la correction
compile-t-elle et réduit-elle les problèmes, les tests générés passent-ils, temps réel contre somme
des temps. Résultats dans `eval/results/` (avec `--fake`, les chiffres de qualité ne veulent rien dire).

## Ajouter un agent

Créer `agents/mon_agent.py` (une fonction `analyze(code, file_path)` et `run_agent_cli("mon_agent",
analyze)`, qui affiche un objet JSON), puis l'ajouter à `AGENTS` dans `orchestrator.py` (avec
`depends_on` s'il utilise le résultat d'un autre). Pour que le planificateur le choisisse, l'ajouter
à `SELECTABLE` dans `agents/planner.py` ; un agent qu'il ne mentionne pas est toujours lancé.

## Licence

Projet éducatif, construit avec des outils gratuits et open source.
