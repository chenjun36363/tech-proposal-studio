import { describe, expect, it } from "vitest";
import { buildHeadingTargetTree, collectCollapsibleHeadingIds, filterHeadingTargetTree, selectAllHeadingTargetIds } from "./chapterParser";

describe("heading tree controls", () => {
  it("filters by title path while retaining ancestors and matching subtrees", () => {
    const tree = buildHeadingTargetTree("# Root\n\n## Alpha\n\n### Setup\n\n#### Detail\n\n## Beta\n\n### Deploy\n");
    const childMatch = filterHeadingTargetTree(tree, "detail");
    expect(childMatch.map(node => node.target.title)).toEqual(["Alpha"]);
    expect(childMatch[0].children[0].children[0].target.title).toBe("Detail");

    const parentMatch = filterHeadingTargetTree(tree, "alpha");
    expect(parentMatch[0].children[0].children[0].target.title).toBe("Detail");
    expect(filterHeadingTargetTree(tree, "missing")).toEqual([]);
  });

  it("collects collapsible nodes and selects only top-level targets", () => {
    const tree = buildHeadingTargetTree("# Root\n\n## Alpha\n\n### Setup\n\n#### Detail\n\n## Beta\n");
    expect(collectCollapsibleHeadingIds(tree)).toEqual([
      tree[0].target.id,
      tree[0].children[0].target.id,
    ]);
    expect(selectAllHeadingTargetIds(tree)).toEqual([tree[0].target.id, tree[1].target.id]);
  });
});
