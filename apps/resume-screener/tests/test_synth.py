import random

from faker import Faker

from resume_screener.decisioner import decide
from resume_screener.synth import synthesize


def test_synthesize_produces_valid_decisions() -> None:
    rng = random.Random(0)
    faker = Faker()
    Faker.seed(0)

    decisions = set()
    for i in range(40):
        pair = synthesize(rng, faker)
        out = decide(resume=pair.resume_text, jd=pair.jd_text, seed=i)
        assert out["decision"] in {"shortlist", "refer", "reject"}
        assert 0.0 <= out["confidence"] <= 1.0
        assert pair.jd_title
        decisions.add(out["decision"])

    # With 40 samples spanning strong/moderate/weak archetypes we expect
    # the synthesizer to produce some variety, not just one class.
    assert len(decisions) >= 2
