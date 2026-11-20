import json
import os
import queue
import subprocess
import sys
import threading
import time

argv = sys.argv[1:]
log_path = argv[argv.index("--fake-log") + 1]
resumed = "--resume" in argv
SESSION = "fake-session-" + str(os.getpid())
EMAIL = "owner@example.test"
WARM_DELAY = 0.8 if "--fake-slow-warm" in argv else 0


def out(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def log(entry: dict) -> None:
    with open(log_path, "a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")


def init() -> None:
    tools = argv[argv.index("--tools") + 1].split(",") if "--tools" in argv and argv[argv.index("--tools") + 1] else []
    servers = json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"] if "--mcp-config" in argv else {}
    if "janet_lab" in servers:
        tools += ["mcp__janet_lab__" + name for name in ("builders", "objectives", "health", "pull_requests")]
    if "janet_call" in servers:
        tools += ["mcp__janet_call__" + name for name in ("ask_to_end_call", "end_call")]
    if "--fake-leak-tools" in argv or ("--permission-mode" in argv and not tools):
        tools = [*tools, "Bash"]
    out({"type": "system", "subtype": "init", "session_id": SESSION, "mcp_servers": [{"name": name} for name in servers], "tools": tools})


def reply_to(prompt: str) -> str:
    said = prompt.rsplit(" says: ", 1)[-1]
    if "--fake-slow-first" in argv and "says" in prompt:
        time.sleep(1.0)
    if "warm-up" in prompt:
        time.sleep(WARM_DELAY)
        return "ready"
    if "conversation is over" in prompt:
        if "--fake-slow-summary" in argv:
            time.sleep(2)
        return "They talked about test things."
    if said.startswith("fake-call-tools:"):
        servers = json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]
        server = servers["janet_call"]
        if "--fake-call-speech" in argv:
            out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "All set."}}})
        for name in said.removeprefix("fake-call-tools:").split(","):
            out({"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "mcp__janet_call__" + name}}})
            request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": {}}}
            proc = subprocess.run([server["command"], *server["args"]], input=json.dumps(request) + "\n", capture_output=True, text=True, timeout=5, check=True)
            log({"call_tool": name, "result": json.loads(proc.stdout)["result"]})
        if "--fake-call-relay" in argv:
            return "All set.\n<relay>\nask: schedule the reminder\ncommitment: the reminder will be relayed\n</relay>"
        return "All set." if "--fake-call-speech" in argv else ""
    if "what builders are running?" in said:
        servers = json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"] if "--mcp-config" in argv else {}
        if "janet_lab" not in servers:
            return "I cannot check the lab on this call."
        server = servers["janet_lab"]
        out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Let me check."}}})
        out({"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "mcp__janet_lab__builders"}}})
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "builders", "arguments": {}}}
        proc = subprocess.run([server["command"], *server["args"]], input=json.dumps(request) + "\n", capture_output=True, text=True, timeout=5, check=True)
        result = json.loads(proc.stdout)["result"]
        text = result["content"][0]["text"]
        log({"lab_result": text, "lab_error": result["isError"]})
        return "The running builders are: " + text.replace("\n", "; ") + "."
    if "silentcase" in said:
        return ""
    if "fillercase" in said:
        return "Go ahead, I'm listening."
    if "relayfirst" in said:
        return "<RELAY>\nask: do the first thing\n</RELAY>\nSure thing."
    if "tworelays" in said:
        return "Okay.\n<relay>\nask: first thing\n</relay>\nAlso noted.\n[relay]\nask: second thing\n[/relay]\nDone."
    if "onlyrelay" in said:
        return "<relay>\nask: quiet thing\n</relay>"
    if "order" in said:
        return f"I will pass that to main. <relay>\nask: {said}\ncommitment: main will handle it\n</relay>"
    if "count" in said:
        return " ".join(f"Number {n}." for n in range(1, 200))
    if "email" in said:
        return f"The account is {EMAIL}, I think."
    if "what did I hear" in said:
        return "You heard: " + (prompt.split('Only this much was heard: "', 1)[1].split('"', 1)[0] if "Only this much" in prompt else "everything") + "."
    return f"You said {said}. That is all I know."


log({"argv": argv, "cwd": os.getcwd(), "env": sorted(os.environ), "base_url": os.environ.get("ANTHROPIC_BASE_URL"), "extra": os.environ.get("MAIN_LIKE_MARK")})
incoming: queue.Queue = queue.Queue()


def read_stdin() -> None:
    for line in sys.stdin:
        incoming.put(json.loads(line))
    incoming.put(None)


threading.Thread(target=read_stdin, daemon=True).start()


def interrupt_waiting() -> bool:
    try:
        message = incoming.get_nowait()
    except queue.Empty:
        return False
    return message is not None and message["type"] == "control_request" and message["request"]["subtype"] == "interrupt"


while (message := incoming.get()) is not None:
    if message["type"] == "control_request" and message["request"]["subtype"] == "initialize":
        out({"type": "control_response", "response": {"response": {"account": {"email": EMAIL}}}})
        if resumed and "--fake-late-init" in argv:
            # What a fork does since 2026-11-17: a title, and its tools only on the first turn.
            out({"type": "system", "subtype": "session_title_changed", "title": "Main", "session_id": SESSION})
        elif resumed:
            init()
            out({"type": "result", "num_turns": 0})
    elif message["type"] == "user":
        prompt = message["message"]["content"]
        log({"prompt": prompt})
        init()
        out({"type": "system", "subtype": "status", "status": "requesting"})
        reply, aborted = reply_to(prompt), False
        if "lookup" in prompt.rsplit(" says: ", 1)[-1]:
            # A lookup: a spoken bridge line, then the tool call, then the answer, with no space between the texts.
            def delta(text):
                out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}})
            delta("One sec, checking.")
            out({"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "WebSearch"}}})
            time.sleep(0.5)
            reply = "It closes at nine."
        for start in range(0, len(reply), 12):
            out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": reply[start:start + 12]}}})
            if "count" in prompt:
                time.sleep(0.02)
                if aborted := interrupt_waiting():
                    break
        out({"type": "result", "terminal_reason": "aborted_streaming"} if aborted else {"type": "result", "num_turns": 1})
