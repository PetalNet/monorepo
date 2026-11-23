pkgs: fold-cards:
let
  provider = pkgs.writeShellScript "fold-test-provider" ''
    printf '%s\n' '{"test":"synthetic-secret-0123"}'
  '';
in
pkgs.runCommand "fold-retrieval-check" { } ''
  unset FOLD_SECRET_SCANNER_ARGV
  export VAULT_SECRET_PROVIDER_ARGV='${builtins.toJSON [ "${provider}" ]}'
  cat > transcript.jsonl <<'JSON'
  {"type":"user","uuid":"public","message":{"content":"Fold smoke marker."}}
  {"type":"user","uuid":"secret","message":{"content":"synthetic-secret-0123"}}
  {"type":"user","uuid":"boundary","message":{"content":"Another turn."}}
  JSON

  cards=${fold-cards}/bin/cards.py
  "$cards" build --session smoke --transcript "$PWD/transcript.jsonl" --db cards.db
  "$cards" unfold smoke:public --db cards.db | grep -F 'Fold smoke marker.'
  rc=0
  "$cards" unfold smoke:secret --db cards.db > refused || rc=$?
  [ "$rc" = 2 ]
  [ ! -s refused ]
  touch "$out"
''
