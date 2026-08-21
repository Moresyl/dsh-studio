//! The count an icon wears.
//!
//! Every desktop has a badge and no two agree on it: macOS counts on the dock,
//! Linux counts on the launcher, and Windows has no number at all — its taskbar
//! takes a picture and draws it in the corner. So the number is drawn here, once,
//! and used for both the picture Windows wants and the tray icon, which is the
//! one mark still on screen when the window is not.
//!
//! Drawn rather than shipped as files because the count is not known in advance,
//! and drawn at the size of whatever it is stamped onto because that size is a
//! platform's choice: Windows hands out a 32px icon, Linux a 512px one, and a
//! badge that looked right on one would be a smudge or a wall on the other.

use tauri::image::Image;

/// Vermilion, and not from the theme.
///
/// A tray icon sits on the system's ground, not on ours, so it does not follow
/// the app between light and dark: it has to stay legible on a black taskbar and
/// on a white one, and be the same mark in both. This is the one red that reads
/// as "a number is waiting" on every desktop.
const FILL: [f32; 3] = [0.898, 0.243, 0.298];

/// White, because a count is read at sixteen pixels or not at all.
const INK: [u8; 3] = [255, 255, 255];

/// The plus that stands in for everything past nine.
const PLUS: usize = 10;

/// Digits three wide and five tall, one bit per cell, high bit leftmost.
///
/// The smallest grid a digit survives in — anything narrower and 8 and 0 stop
/// being different marks. Two glyphs is the whole vocabulary needed: a count, or
/// a nine and a plus once counting stops being the point.
const GLYPHS: [[u8; 5]; 11] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b010, 0b010, 0b010], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
    [0b000, 0b010, 0b111, 0b010, 0b000], // +
];

const GLYPH_WIDTH: u32 = 3;
const GLYPH_HEIGHT: u32 = 5;

/// How the badge is laid out, in whole pixels, before anything is drawn.
struct Plan {
    /// Which glyphs, left to right.
    glyphs: Vec<usize>,
    /// Pixels per glyph cell.
    scale: u32,
    width: u32,
    height: u32,
}

impl Plan {
    /// Lay a count out at `scale`, or nothing at all when there is none.
    fn read(count: u32, scale: u32) -> Option<Self> {
        let glyphs: Vec<usize> = match count {
            0 => return None,
            // Past nine the exact number stops fitting and stops mattering: the
            // badge says there is a pile, and the tooltip says how big.
            1..=9 => vec![count as usize],
            _ => vec![9, PLUS],
        };

        let run = glyphs.len() as u32 * GLYPH_WIDTH + (glyphs.len() as u32 - 1);
        let height = (GLYPH_HEIGHT + 3) * scale;

        Some(Plan {
            scale,
            // A pill, never narrower than it is tall: one glyph gives a circle
            // and two give the stretched form every badge on every platform uses.
            width: ((run + 3) * scale).max(height),
            height,
            glyphs,
        })
    }
}

/// A rounded rectangle, in pixels.
struct Pill {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
}

impl Pill {
    /// Grow in every direction, which is how the moat is described.
    fn grown(&self, by: f32) -> Self {
        Pill {
            x: self.x - by,
            y: self.y - by,
            width: self.width + by * 2.0,
            height: self.height + by * 2.0,
            radius: self.radius + by,
        }
    }

    /// Signed distance from a point to the edge, negative inside.
    fn distance(&self, px: f32, py: f32) -> f32 {
        let dx = (px - (self.x + self.width / 2.0)).abs() - self.width / 2.0 + self.radius;
        let dy = (py - (self.y + self.height / 2.0)).abs() - self.height / 2.0 + self.radius;
        let outside = (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt();
        outside + dx.max(dy).min(0.0) - self.radius
    }

    /// How much of one pixel the shape covers, sampled on a 4×4 grid.
    ///
    /// Sampled rather than solved because the alternative at these sizes is a
    /// staircase: a sixteen pixel circle with hard edges reads as a lump, and the
    /// badge is a shape people recognise before they read it.
    fn coverage(&self, x: u32, y: u32) -> f32 {
        const STEPS: u32 = 4;
        let mut hits = 0.0;

        for row in 0..STEPS {
            for column in 0..STEPS {
                let px = x as f32 + (column as f32 + 0.5) / STEPS as f32;
                let py = y as f32 + (row as f32 + 0.5) / STEPS as f32;
                if self.distance(px, py) <= 0.0 {
                    hits += 1.0;
                }
            }
        }

        hits / (STEPS * STEPS) as f32
    }
}

/// Copy `base` and put `count` in its bottom-right corner.
///
/// The badge is half the icon, which is the proportion that survives being drawn
/// again at sixteen pixels by the tray.
pub fn stamp(base: &Image<'_>, count: u32) -> Image<'static> {
    let (width, height) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();

    if let Some(plan) = Plan::read(count, (width.min(height) / 16).max(1)) {
        let x = width.saturating_sub(plan.width);
        let y = height.saturating_sub(plan.height);
        // A ring of nothing between the badge and the mark it sits on, so the
        // two read as two things at the size a taskbar draws them.
        paint(&mut rgba, width, height, &plan, x, y, true);
    }

    Image::new_owned(rgba, width, height)
}

/// The badge on its own, for a taskbar that draws it beside the app rather than
/// on it. Square, because that is the shape every overlay slot expects.
#[cfg(any(windows, test))]
pub fn alone(count: u32) -> Option<Image<'static>> {
    let plan = Plan::read(count, 4)?;

    let side = plan.width.max(plan.height);
    let mut rgba = vec![0u8; (side * side * 4) as usize];
    paint(
        &mut rgba,
        side,
        side,
        &plan,
        (side - plan.width) / 2,
        (side - plan.height) / 2,
        false,
    );

    Some(Image::new_owned(rgba, side, side))
}

/// Composite the badge into `rgba` with its top-left corner at `x`, `y`.
fn paint(rgba: &mut [u8], width: u32, height: u32, plan: &Plan, x: u32, y: u32, moat: bool) {
    let pill = Pill {
        x: x as f32,
        y: y as f32,
        width: plan.width as f32,
        height: plan.height as f32,
        radius: plan.height as f32 / 2.0,
    };
    let gap = pill.grown(if moat { plan.scale as f32 } else { 0.0 });

    let from_x = (x.saturating_sub(plan.scale)).min(width);
    let from_y = (y.saturating_sub(plan.scale)).min(height);

    for py in from_y..height {
        for px in from_x..width {
            let cleared = if moat { gap.coverage(px, py) } else { 0.0 };
            let covered = pill.coverage(px, py);
            if cleared <= 0.0 && covered <= 0.0 {
                continue;
            }

            let at = ((py * width + px) * 4) as usize;
            // The moat first: it takes the icon out from under the badge, and
            // what the badge itself covers is about to be replaced anyway.
            let under = f32::from(rgba[at + 3]) / 255.0 * (1.0 - cleared);
            let alpha = covered + under * (1.0 - covered);

            for channel in 0..3 {
                let below = f32::from(rgba[at + channel]) / 255.0;
                let mixed = if alpha <= 0.0 {
                    0.0
                } else {
                    (FILL[channel] * covered + below * under * (1.0 - covered)) / alpha
                };
                rgba[at + channel] = (mixed * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            rgba[at + 3] = (alpha * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    write(rgba, width, height, plan, x, y);
}

/// Stamp the glyphs into the middle of the pill.
fn write(rgba: &mut [u8], width: u32, height: u32, plan: &Plan, x: u32, y: u32) {
    let run = plan.glyphs.len() as u32 * GLYPH_WIDTH + (plan.glyphs.len() as u32 - 1);
    let left = x + (plan.width - run * plan.scale) / 2;
    let top = y + (plan.height - GLYPH_HEIGHT * plan.scale) / 2;

    for (index, glyph) in plan.glyphs.iter().enumerate() {
        let origin = left + index as u32 * (GLYPH_WIDTH + 1) * plan.scale;

        for (row, bits) in GLYPHS[*glyph].iter().enumerate() {
            for column in 0..GLYPH_WIDTH {
                if bits & (1 << (GLYPH_WIDTH - 1 - column)) == 0 {
                    continue;
                }
                fill(
                    rgba,
                    width,
                    height,
                    origin + column * plan.scale,
                    top + row as u32 * plan.scale,
                    plan.scale,
                );
            }
        }
    }
}

/// One cell of a glyph: a square of opaque ink.
fn fill(rgba: &mut [u8], width: u32, height: u32, x: u32, y: u32, scale: u32) {
    for py in y..(y + scale).min(height) {
        for px in x..(x + scale).min(width) {
            let at = ((py * width + px) * 4) as usize;
            rgba[at..at + 3].copy_from_slice(&INK);
            rgba[at + 3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plain 32×32 mark, opaque everywhere, so any change is the badge's.
    fn icon() -> Image<'static> {
        Image::new_owned([40, 60, 90, 255].repeat(32 * 32), 32, 32)
    }

    fn alpha_at(image: &Image<'_>, x: u32, y: u32) -> u8 {
        image.rgba()[((y * image.width() + x) * 4 + 3) as usize]
    }

    /// The icon is a fixed-size slot on every platform that has one, so a badge
    /// that resized it would be a badge that does not fit anywhere.
    #[test]
    fn stamping_never_changes_the_shape_of_the_icon() {
        let stamped = stamp(&icon(), 3);
        assert_eq!(stamped.width(), 32);
        assert_eq!(stamped.height(), 32);
        assert_eq!(stamped.rgba().len(), icon().rgba().len());
    }

    /// Zero is not a small number to draw; it is the absence of one.
    #[test]
    fn nothing_is_drawn_for_a_count_of_zero() {
        assert_eq!(stamp(&icon(), 0).rgba(), icon().rgba());
        assert!(alone(0).is_none());
    }

    /// The bottom-right corner is where every desktop puts a count, and the
    /// opposite corner is where the mark itself has to survive.
    #[test]
    fn the_badge_lands_in_the_corner_and_leaves_the_rest_alone() {
        let stamped = stamp(&icon(), 1);

        // The middle of the badge: a pill in the corner rounds away from the
        // corner pixel itself, so that is not the one to ask about.
        let inside = ((24 * 32 + 24) * 4) as usize;
        assert_ne!(&stamped.rgba()[inside..inside + 3], &[40, 60, 90]);
        assert_eq!(&stamped.rgba()[0..4], &[40, 60, 90, 255]);
    }

    /// The gap is what stops the badge from reading as part of the artwork once
    /// the tray has drawn both at sixteen pixels.
    #[test]
    fn a_ring_of_the_icon_is_cleared_from_under_the_badge() {
        let stamped = stamp(&icon(), 1);
        let bare = (0..32).any(|y| (0..32).any(|x| alpha_at(&stamped, x, y) == 0));
        assert!(bare, "the moat left no transparent pixel");
    }

    /// The overlay slot is drawn beside the app rather than on it, so it carries
    /// the badge and nothing else — and a square is what the slot expects.
    #[test]
    fn the_standalone_badge_is_square_and_has_no_moat() {
        let badge = alone(4).expect("a count of four is drawable");
        assert_eq!(badge.width(), badge.height());

        let corner = alpha_at(&badge, 0, 0);
        let middle = alpha_at(&badge, badge.width() / 2, badge.height() / 2);
        assert_eq!(corner, 0, "the corner outside the pill stays empty");
        assert_eq!(middle, 255, "the pill itself is opaque");
    }

    /// Nine is the last count that fits; everything above it is the same pile.
    #[test]
    fn counting_stops_at_nine() {
        let nine = Plan::read(9, 2).expect("nine is drawable");
        assert_eq!(nine.glyphs, vec![9]);

        for count in [10, 42, u32::MAX] {
            let plan = Plan::read(count, 2).expect("a pile is drawable");
            assert_eq!(plan.glyphs, vec![9, PLUS], "{count}");
            assert!(plan.width > nine.width, "two glyphs need a wider pill");
            assert_eq!(plan.height, nine.height, "and exactly the same height");
        }
    }

    /// One glyph gives a circle: the pill is never taller than it is wide.
    #[test]
    fn a_single_digit_badge_is_round() {
        let plan = Plan::read(7, 3).expect("seven is drawable");
        assert_eq!(plan.width, plan.height);
    }

    /// The scale follows the icon, because the icon's size is the platform's
    /// choice and the badge has to be the same fraction of both.
    #[test]
    fn the_badge_is_the_same_fraction_of_any_icon() {
        let small = Image::new_owned([0, 0, 0, 255].repeat(32 * 32), 32, 32);
        let large = Image::new_owned([0, 0, 0, 255].repeat(256 * 256), 256, 256);

        let ratio = |image: &Image<'_>| {
            let plan = Plan::read(1, (image.width() / 16).max(1)).expect("one is drawable");
            plan.height as f32 / image.height() as f32
        };

        assert!((ratio(&small) - ratio(&large)).abs() < 0.01);
    }
}
