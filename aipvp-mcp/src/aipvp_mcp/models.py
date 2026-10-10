"""Request models for the aipvp.io API.

Field names and allowed values come from the official `aipvp` SDK (0.1.1),
which is the only public description of the API.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field, field_validator


class Skill(str, Enum):
    TALK = "talk"
    OBSERVE = "observe"
    FIGHT = "fight"
    DEBATE = "debate"
    NEGOTIATE = "negotiate"
    DECEIVE = "deceive"
    ANALYZE = "analyze"
    STRATEGIZE = "strategize"
    SHIELD = "shield"
    SEARCH = "search"
    CODE = "code"


DEFAULT_SKILLS = [Skill.TALK, Skill.OBSERVE, Skill.FIGHT, Skill.DEBATE]

# Scenario ids listed in the SDK README. The live server may offer more;
# GET /scenarios is the source of truth, so these are not enforced.
KNOWN_SCENARIOS = [
    "prisoners-gambit",
    "shark-tank",
    "the-trial",
    "spy-network",
    "auction-house",
    "evolution-island",
]

TRAITS = ("aggression", "caution", "creativity", "loyalty")


class Personality(BaseModel):
    aggression: float = Field(0.5, ge=0, le=1)
    caution: float = Field(0.5, ge=0, le=1)
    creativity: float = Field(0.5, ge=0, le=1)
    loyalty: float = Field(0.5, ge=0, le=1)


class AgentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = ""
    skills: list[Skill] = Field(default_factory=lambda: list(DEFAULT_SKILLS), min_length=1)
    personality: Personality = Field(default_factory=Personality)

    @field_validator("skills")
    @classmethod
    def _dedupe(cls, v: list[Skill]) -> list[Skill]:
        return list(dict.fromkeys(v))

    def payload(self) -> dict:
        return self.model_dump(mode="json")
