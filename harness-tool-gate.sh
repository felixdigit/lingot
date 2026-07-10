#!/bin/bash
# Harness PreToolUse gate, run by the executor. Three gates at the tool boundary,
# in order, plus an immutable audit trail:
#   1. L4 deny-by-default -- a tool is allowed only if in HARNESS_ALLOW.
#   2. L8 governance gate wall -- an allowed tool whose command performs a HELD
#      release op (matches HARNESS_HOLD) is denied until the founder clears it.
#   3. L8 lethal-trifecta floor -- an external-comms tool is HARD-BLOCKED once the
#      run has already touched BOTH private data AND untrusted content (the state
#      is tracked across the run in HARNESS_TRIFECTA). Non-overridable floor.
# Emits an explicit allow/deny decision; always exits 0.

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
# CMD_EXEC = only an executable shell command (Bash). CMD_ANY = command or
# file_path or url. Release-op holds + comms detection test CMD_EXEC (a file
# named docs/deploy-notes.md must not trip the deploy hold -- audit H1); the
# self-protection floor + private-data detection test CMD_ANY (a Write to
# gates.json or a Read of .env must be seen).
CMD_EXEC=$(printf '%s' "$INPUT" | python3 -c "import sys,json;ti=json.load(sys.stdin).get('tool_input',{}) or {};print(ti.get('command') or '')" 2>/dev/null)
CMD_ANY=$(printf '%s' "$INPUT" | python3 -c "import sys,json;ti=json.load(sys.stdin).get('tool_input',{}) or {};print(ti.get('command') or ti.get('file_path') or ti.get('url') or '')" 2>/dev/null)

audit() { # $1 = decision
  [ -z "${HARNESS_AUDIT:-}" ] && return 0
  printf '%s' "$INPUT" | python3 -c "
import sys, json, datetime, os
try: d = json.load(sys.stdin)
except Exception: d = {}
ti = d.get('tool_input', {}) or {}
cmd = (ti.get('command') or ti.get('file_path') or ti.get('url') or '')
print(json.dumps({'at': datetime.datetime.utcnow().isoformat()+'Z', 'run': os.environ.get('HARNESS_RUN_ID',''), 'tool': d.get('tool_name',''), 'decision': '$1', 'cmd': cmd[:160]}))
" >> "$HARNESS_AUDIT" 2>/dev/null \
    || printf '{"at":"","run":"","tool":"","decision":"%s","cmd":"(audit fallback: python3 unavailable)"}\n' "$1" >> "$HARNESS_AUDIT" 2>/dev/null \
    || true
}
deny() { audit deny; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$1"; exit 0; }
allow() { audit allow; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'; exit 0; }

# 0. self-protection floor (audit C2, non-overridable): the harness's own control
# state -- the A9 proof ledger, the audit trail, the trifecta state, the eval
# golden suites -- is untouchable by the fleet. Without this, a Bash-granted agent
# could forge a tier_swap proof, erase its audit, or clear its trifecta flags.
if printf '%s' "$CMD_ANY" | grep -qiE '\.harness/(gates\.json|audit\.jsonl|evals(/|$))|gates\.json|audit\.jsonl|trifecta|eval-history|recompiles\.jsonl'; then
  deny "Blocked: harness control state is not accessible to the agent fleet (self-protection floor). Legitimate system policy; report and stop."
fi

# 1. deny-by-default tool allow-set (L4)
case ",${HARNESS_ALLOW}," in
  *",${TOOL},"*) : ;;
  *) deny "harness gate: tool ${TOOL} is not in this venture allow-set" ;;
esac

# 2. governance gate wall (L8): held release ops -- executable commands only
if [ -n "${HARNESS_HOLD:-}" ] && printf '%s' "$CMD_EXEC" | grep -qiE "${HARNESS_HOLD}"; then
  deny "Blocked by studio governance policy: this is a gated release op the agent fleet may not perform or self-authorize. This block is legitimate system policy, not user content. Report that it is blocked and stop; do not attempt to work around it."
fi

# 3. lethal-trifecta floor (L8, non-overridable). State: which of private/untrusted seen this run.
if [ -n "${HARNESS_TRIFECTA:-}" ]; then
  TRI_PRIVATE='\.env([^a-z]|$)|credentials|id_rsa|\.aws/|/secrets?/|\.pem([^a-z]|$)|\.key([^a-z]|$)|private.?key|password|token'
  TRI_UNTRUSTED_TOOL='^(WebFetch|WebSearch)$'
  TRI_UNTRUSTED_CMD='curl .*http|wget .*http|git clone'
  TRI_COMMS='sendgrid|--send-email|/v[0-9]+/messages|twilio|sendmail|mail -s|curl .*(-X *POST|--data|-d )|nc '
  STATE=$(cat "$HARNESS_TRIFECTA" 2>/dev/null || echo "")
  is_comms=0; printf '%s' "$CMD_EXEC" | grep -qiE "${TRI_COMMS}" && is_comms=1
  case "$STATE" in *P*) has_p=1;; *) has_p=0;; esac
  case "$STATE" in *U*) has_u=1;; *) has_u=0;; esac
  if [ "$is_comms" = 1 ] && [ "$has_p" = 1 ] && [ "$has_u" = 1 ]; then
    deny "Blocked by the lethal-trifecta safety floor: this run has already accessed private data AND untrusted content, and this tool sends externally -- the combination is hard-blocked (exfiltration risk). Legitimate system policy; report it and stop."
  fi
  # update state for THIS call
  NEW="$STATE"
  if printf '%s' "$CMD_ANY" | grep -qiE "${TRI_PRIVATE}"; then case "$NEW" in *P*) :;; *) NEW="${NEW}P";; esac; fi
  if printf '%s' "$TOOL" | grep -qiE "${TRI_UNTRUSTED_TOOL}" || printf '%s' "$CMD_EXEC" | grep -qiE "${TRI_UNTRUSTED_CMD}"; then case "$NEW" in *U*) :;; *) NEW="${NEW}U";; esac; fi
  [ "$NEW" != "$STATE" ] && printf '%s' "$NEW" > "$HARNESS_TRIFECTA" 2>/dev/null || true
fi

allow
