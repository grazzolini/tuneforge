from __future__ import annotations

from app.services.beat_backends import list_beat_backend_infos


def test_beat_backend_registry_marks_missing_advanced_backend(monkeypatch):
    def fake_find_spec(module_name: str):
        return None if module_name == "beat_this" else object()

    monkeypatch.setattr("app.engines.beat_this.importlib.util.find_spec", fake_find_spec)

    backends = {backend["id"]: backend for backend in list_beat_backend_infos()}

    assert backends["built-in"]["availability"] == "available"
    assert backends["built-in"]["runtime_device"] == "cpu"
    assert backends["beat-this"]["availability"] == "unavailable"
    assert backends["beat-this"]["desktopOnly"] is True
    assert backends["beat-this"]["unavailable_reason"] == (
        "Install the optional advanced-beats dependency to use Advanced Beat Analysis."
    )


def test_beat_backends_api_marks_missing_advanced_backend(client, monkeypatch):
    def fake_find_spec(module_name: str):
        return None if module_name == "beat_this" else object()

    monkeypatch.setattr("app.engines.beat_this.importlib.util.find_spec", fake_find_spec)

    response = client.get("/api/v1/beat-backends")

    assert response.status_code == 200
    backends = {backend["id"]: backend for backend in response.json()["backends"]}
    assert backends["built-in"]["available"] is True
    assert backends["beat-this"]["available"] is False
    assert backends["beat-this"]["runtime_device"] == "cpu"
