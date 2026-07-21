import assert from "node:assert/strict";
import test from "node:test";
import { measureMobilePlaybackFollowLayouts } from "./capture-release-media.mjs";

const scenarios = [
  { name: "360 CSS px", width: 360 },
  { name: "411 CSS px", width: 411 },
  {
    name: "360 CSS px at 200% text with Follow unavailable",
    width: 360,
    textScale: 2,
    followAvailable: false,
  },
];

test("mobile Follow relocation remains usable in real Chromium layout", { timeout: 120_000 }, async () => {
  const results = await measureMobilePlaybackFollowLayouts(scenarios);

  for (const { name, width, followAvailable = true, measurement } of results) {
    const {
      appBar,
      clippingAncestors,
      containers,
      explanation,
      follow,
      heading,
      headingGrid,
      mode,
      overflow,
      practiceBody,
      transport,
      viewport,
    } = measurement;
    assert.equal(viewport.width, width, name);
    assert.equal(follow.visible, true, `${name}: Follow must remain visible`);
    assert.ok(follow.rect.width >= 48, `${name}: Follow width must be at least 48 CSS px`);
    assert.ok(follow.rect.height >= 48, `${name}: Follow height must be at least 48 CSS px`);

    assert.equal(rectanglesOverlap(heading.rect, follow.rect), false, `${name}: heading overlaps Follow`);
    assert.equal(rectanglesOverlap(heading.rect, mode.rect), false, `${name}: heading overlaps mode selector`);
    assert.equal(rectanglesOverlap(follow.rect, mode.rect), false, `${name}: Follow overlaps mode selector`);
    assert.ok(
      headingGrid.rect.bottom <= mode.rect.top + 1,
      `${name}: heading row must remain above mode selector`,
    );
    assert.ok(practiceBody.rect.height > 0, `${name}: practice body must remain usable`);

    for (const [index, action] of appBar.actions.entries()) {
      assert.ok(action.width >= 48, `${name}: app-bar action ${index + 1} is narrower than 48px`);
      assert.ok(action.height >= 48, `${name}: app-bar action ${index + 1} is shorter than 48px`);
      assert.equal(
        rectangleContains(appBar.container, action),
        true,
        `${name}: app-bar action ${index + 1} escapes the app bar`,
      );
      assert.equal(
        rectanglesOverlap(appBar.title, action),
        false,
        `${name}: app-bar title overlaps action ${index + 1}`,
      );
    }
    assert.ok(
      appBar.overflow.scrollWidth <= appBar.overflow.clientWidth + 1,
      `${name}: app bar has horizontal overflow`,
    );

    assert.equal(
      rectanglesOverlap(transport.controls, transport.timeline),
      false,
      `${name}: transport controls overlap timeline`,
    );
    for (const [part, rect] of Object.entries({
      controls: transport.controls,
      timeline: transport.timeline,
      scrubber: transport.scrubber,
      range: transport.range,
    })) {
      assert.equal(
        rectangleContains(transport.dock, rect),
        true,
        `${name}: transport ${part} escapes the dock`,
      );
    }
    for (const [index, button] of transport.buttons.entries()) {
      assert.ok(button.width >= 48, `${name}: transport button ${index + 1} is narrower than 48px`);
      assert.ok(button.height >= 48, `${name}: transport button ${index + 1} is shorter than 48px`);
      assert.equal(
        rectangleContains(transport.controls, button),
        true,
        `${name}: transport button ${index + 1} escapes the controls row`,
      );
    }
    for (const [part, dimensions] of Object.entries(transport.overflow)) {
      if (part === "controls") {
        assert.ok(
          dimensions.scrollWidth <= dimensions.clientWidth + 1,
          `${name}: transport controls have horizontal overflow`,
        );
      } else {
        assertNoOverflow(name, `transport ${part}`, dimensions);
      }
    }

    for (const [container, dimensions] of Object.entries(overflow)) {
      assert.ok(
        dimensions.scrollWidth <= dimensions.clientWidth + 1,
        `${name}: ${container} has horizontal overflow ` +
          `(${dimensions.scrollWidth} > ${dimensions.clientWidth})`,
      );
    }

    if (followAvailable) {
      assert.equal(explanation, null, `${name}: available Follow must not show disabled copy`);
    } else {
      assert.equal(explanation?.visible, true, `${name}: disabled explanation must remain visible`);
      assert.equal(
        rectangleContains({ top: 0, left: 0, right: viewport.width, bottom: viewport.height }, explanation.rect),
        true,
        `${name}: disabled explanation must be inside the viewport`,
      );
      for (const [container, rect] of Object.entries(containers)) {
        assert.equal(
          rectangleContains(rect, explanation.rect),
          true,
          `${name}: disabled explanation is clipped by ${container}`,
        );
      }
      for (const ancestor of clippingAncestors) {
        assert.equal(
          rectangleContains(ancestor, explanation.rect),
          true,
          `${name}: disabled explanation is clipped by ${ancestor.className}`,
        );
      }
      assert.ok(
        explanation.rect.bottom <= mode.rect.top + 1,
        `${name}: disabled explanation overlaps mode selector`,
      );
    }
  }
});

function rectanglesOverlap(first, second, tolerance = 1) {
  return (
    first.left < second.right - tolerance &&
    first.right > second.left + tolerance &&
    first.top < second.bottom - tolerance &&
    first.bottom > second.top + tolerance
  );
}

function assertNoOverflow(name, container, dimensions, tolerance = 1) {
  assert.ok(
    dimensions.scrollWidth <= dimensions.clientWidth + tolerance,
    `${name}: ${container} has horizontal overflow ` +
      `(${dimensions.scrollWidth} > ${dimensions.clientWidth})`,
  );
  assert.ok(
    dimensions.scrollHeight <= dimensions.clientHeight + tolerance,
    `${name}: ${container} has vertical overflow ` +
      `(${dimensions.scrollHeight} > ${dimensions.clientHeight})`,
  );
}

function rectangleContains(container, content, tolerance = 1) {
  return (
    content.left >= container.left - tolerance &&
    content.right <= container.right + tolerance &&
    content.top >= container.top - tolerance &&
    content.bottom <= container.bottom + tolerance
  );
}
