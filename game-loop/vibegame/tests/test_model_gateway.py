from unittest.mock import Mock

from model_gateway import ModelGateway, ModelRequest, ProviderConfig


def _response(payload, status=200):
    response = Mock(status_code=status, headers={"x-request-id": "req_1"}, text="")
    response.json.return_value = payload
    return response


def test_openai_responses_route_and_extract():
    session = Mock()
    session.post.return_value = _response({"output_text": "ok", "usage": {"input_tokens": 2}})
    gateway = ModelGateway(
        ProviderConfig("openai", "https://api.openai.com/v1", "gpt-test", "secret", "responses"),
        session,
    )
    result = gateway.generate(ModelRequest("hello", instructions="be brief"))
    assert result.ok and result.text == "ok"
    assert session.post.call_args.args[0].endswith("/responses")
    assert session.post.call_args.kwargs["json"]["instructions"] == "be brief"


def test_openai_compatible_route():
    session = Mock()
    session.post.return_value = _response({"choices": [{"message": {"content": "done"}}]})
    gateway = ModelGateway(
        ProviderConfig("qwen", "http://internal/v1", "qwen", "", "openai_chat"), session
    )
    result = gateway.generate(ModelRequest("hello"))
    assert result.ok and result.text == "done"
    assert session.post.call_args.args[0].endswith("/chat/completions")


def test_anthropic_native_route():
    session = Mock()
    session.post.return_value = _response({"content": [{"type": "text", "text": "yes"}]})
    gateway = ModelGateway(
        ProviderConfig("anthropic", "https://api.anthropic.com/v1", "claude", "secret", "anthropic"),
        session,
    )
    assert gateway.generate(ModelRequest("hello")).text == "yes"
    assert session.post.call_args.kwargs["headers"]["anthropic-version"] == "2023-06-01"


def test_gemini_native_route():
    session = Mock()
    session.post.return_value = _response({"candidates": [{"content": {"parts": [{"text": "yes"}]}}]})
    gateway = ModelGateway(
        ProviderConfig("gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini", "secret", "gemini"),
        session,
    )
    assert gateway.generate(ModelRequest("hello")).text == "yes"
    assert session.post.call_args.kwargs["params"] == {"key": "secret"}
