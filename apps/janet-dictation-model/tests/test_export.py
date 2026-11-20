import torch
from safetensors.torch import save_file

from export import load_tied_weights


def test_futo_projection_becomes_shared_embedding_without_rounding(tmp_path):
    input_embedding = torch.tensor([[1.0001, 2.0002]])
    projection = torch.tensor([[3.0003, 4.0004]])
    encoder = torch.tensor([[5.0005]])
    path = tmp_path / "model.safetensors"
    save_file(
        {"model.decoder.embed_tokens.weight": input_embedding, "proj_out.weight": projection, "encoder": encoder}, path
    )
    weights = load_tied_weights(path)
    assert "proj_out.weight" not in weights
    torch.testing.assert_close(weights["model.decoder.embed_tokens.weight"], projection, rtol=0, atol=0)
    torch.testing.assert_close(weights["encoder"], encoder, rtol=0, atol=0)


def test_trained_tied_checkpoint_keeps_its_embedding(tmp_path):
    embedding = torch.tensor([[1.0001, 2.0002]])
    path = tmp_path / "model.safetensors"
    save_file({"model.decoder.embed_tokens.weight": embedding}, path)
    weights = load_tied_weights(path)
    torch.testing.assert_close(weights["model.decoder.embed_tokens.weight"], embedding, rtol=0, atol=0)
