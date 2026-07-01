import { describe, expect, it } from "vitest";
import { readSkillSection, skillIndexForAgent, SKILL_SECTION_NAMES } from "../src/acquisition-v2/skill.js";

describe("subtitle skill section", () => {
  it("is a registered section", () => {
    expect(SKILL_SECTION_NAMES).toContain("subtitle");
  });

  it("readSkillSection('subtitle') returns the subtitle playbook body", () => {
    const body = readSkillSection("subtitle");
    expect(body).toContain("viewSubtitleSnapshot");
    expect(body).toContain("transferSubtitle");
    expect(body).toMatch(/rename|重命名/); // the rename exception
    expect(body).toMatch(/soft|不阻塞|does not block/i); // soft-fail philosophy
  });

  it("both movie and tv skill indexes point at the subtitle section", () => {
    const movie = skillIndexForAgent("movie");
    const tv = skillIndexForAgent("tv");
    expect(movie).toContain("subtitle");
    expect(tv).toContain("subtitle");
  });
});
