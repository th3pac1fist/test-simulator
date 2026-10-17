import json
import stat

import pytest

from aipvp_mcp.cli import main


def run(capsys, *argv):
    main(list(argv))
    return capsys.readouterr().out


def test_full_flow(mock_url, capsys, monkeypatch, isolated_config):
    monkeypatch.setenv("AIPVP_PASSWORD", "password123")
    out = run(capsys, "register", "me@example.com", "--base-url", mock_url)
    assert "Logged in as me" in out
    assert stat.S_IMODE(isolated_config.stat().st_mode) == 0o600
    saved = json.loads(isolated_config.read_text())
    assert saved["base_url"] == mock_url and saved["token"]

    # base URL and token now come from the config file
    agent = json.loads(run(capsys, "agent", "create", "--name", "NEXUS", "--skills", "fight,Talk,observe",
                           "--aggression", "0.8", "--json"))
    assert agent["skills"] == ["fight", "talk", "observe"]
    assert "NEXUS" in run(capsys, "agent", "list")

    match = json.loads(run(capsys, "match", "start", agent["id"], "--json"))
    replay = run(capsys, "match", "replay", match["match_id"])
    assert replay.count("NEXUS [") == 12 and "score" in replay

    assert "NEXUS" in run(capsys, "leaderboard")
    run(capsys, "logout")
    with pytest.raises(SystemExit) as e:
        main(["agent", "list"])
    assert "aipvp login" in str(e.value)


def test_bad_skill_is_rejected_before_any_request(capsys):
    with pytest.raises(SystemExit) as e:
        main(["agent", "create", "--name", "X", "--skills", "fight,laser", "--base-url", "http://127.0.0.1:9/api/v1"])
    assert "laser" in str(e.value) and "Skills:" in str(e.value)


def test_out_of_range_trait(capsys):
    with pytest.raises(SystemExit) as e:
        main(["agent", "create", "--name", "X", "--caution", "2", "--base-url", "http://127.0.0.1:9/api/v1"])
    assert "caution" in str(e.value)


def test_unreachable_hint(capsys):
    with pytest.raises(SystemExit) as e:
        main(["status", "--base-url", "http://127.0.0.1:9/api/v1"])
    assert "AIPVP_BASE_URL" in str(e.value)


def test_start_with_watch_shows_every_turn(mock_url, capsys, monkeypatch):
    monkeypatch.setenv("AIPVP_PASSWORD", "password123")
    run(capsys, "register", "w@example.com", "--base-url", mock_url)
    agent = json.loads(run(capsys, "agent", "create", "--name", "W", "--json"))
    out = run(capsys, "match", "start", agent["id"], "--watch")
    assert sum(line.startswith("T") for line in out.splitlines()) == 24
    assert "Match over:" in out


def test_global_options_before_subcommand(mock_url, capsys, monkeypatch):
    # The env points at the mock, so --base-url given *before* the subcommand must win.
    monkeypatch.setenv("AIPVP_BASE_URL", mock_url)
    with pytest.raises(SystemExit) as e:
        main(["--base-url", "http://127.0.0.1:9/api/v1", "status"])
    assert "127.0.0.1:9" in str(e.value)
    out = run(capsys, "--json", "status")
    assert json.loads(out)["status"] == "ok"


def test_failed_login_has_no_login_hint(mock_url, monkeypatch):
    monkeypatch.setenv("AIPVP_PASSWORD", "wrong-password")
    with pytest.raises(SystemExit) as e:
        main(["login", "nobody@example.com", "--base-url", mock_url])
    assert "Wrong email or password" in str(e.value) and "aipvp login" not in str(e.value)


def test_readable_match_output(mock_url, capsys, monkeypatch):
    monkeypatch.setenv("AIPVP_PASSWORD", "password123")
    run(capsys, "register", "r@example.com", "--base-url", mock_url)
    agent = json.loads(run(capsys, "agent", "create", "--name", "READER", "--json"))
    assert run(capsys, "agent", "history", agent["id"]).strip() == "(no matches yet)"
    line = run(capsys, "match", "start", agent["id"]).strip()
    assert line.startswith("mch_") and "READER" in line and ("winner:" in line or "draw" in line)
    assert "READER" in run(capsys, "agent", "history", agent["id"])
