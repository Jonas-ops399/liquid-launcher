package com.codex.launcher.ui.design

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.ui.unit.dp

/**
 * Liquid Glass Motion System
 *
 * All animations use **spring physics** (not linear/ease curves).
 * Natural, organic feel matching Apple's motion language.
 * Reduced motion accessibility support built-in.
 */
object GlassMotion {

    // =========================================================================
    // Spring Specifications
    // =========================================================================

    /** Standard UI spring: smooth, responsive, not bouncy */
    val SpringStandard = spring<Float>(
        dampingRatio = 0.85f,      // Slightly overdamped - no overshoot
        stiffness = 180f,          // Responsive but not stiff
        visibilityThreshold = 0.001f
    )

    /** Quick spring: for micro-interactions (button press, hover) */
    val SpringQuick = spring<Float>(
        dampingRatio = 0.9f,
        stiffness = 280f,
        visibilityThreshold = 0.001f
    )

    /** Gentle spring: for large panels, scene transitions */
    val SpringGentle = spring<Float>(
        dampingRatio = 0.88f,
        stiffness = 120f,
        visibilityThreshold = 0.001f
    )

    /** Bouncy spring: for delightful moments (preset select, success) */
    val SpringBouncy = spring<Float>(
        dampingRatio = 0.75f,      // Slight overshoot
        stiffness = 200f,
        visibilityThreshold = 0.001f
    )

    /** Entrance spring: coordinated app startup */
    val SpringEntrance = spring<Float>(
        dampingRatio = 0.82f,
        stiffness = 160f,
        visibilityThreshold = 0.001f
    )

    /** Parallax spring: mouse-following layers */
    val SpringParallax = spring<Float>(
        dampingRatio = 0.92f,
        stiffness = 80f,
        visibilityThreshold = 0.01f
    )

    // =========================================================================
    // Duration Tokens (for tween fallbacks / reduced motion)
    // =========================================================================

    val DurationInstant = 0
    val DurationFast = 120        // Micro-interactions
    val DurationNormal = 220      // Standard transitions
    val DurationSlow = 350        // Panel open/close
    val DurationSlowest = 500     // Scene cross-fade, full screen
    val DurationEntrance = 700    // App startup orchestration

    // =========================================================================
    // Animation Specs (ready to use with animate*AsState)
    // =========================================================================

    /** Standard spec for most UI animations */
    val SpecStandard: AnimationSpec<Float> = SpringStandard

    /** Quick spec for hover, press, focus */
    val SpecQuick: AnimationSpec<Float> = SpringQuick

    /** Gentle spec for panels, drawers, large elements */
    val SpecGentle: AnimationSpec<Float> = SpringGentle

    /** Entrance spec for coordinated startup */
    val SpecEntrance: AnimationSpec<Float> = SpringEntrance

    /** Scene cross-fade spec */
    val SpecSceneTransition = spring<Float>(
        dampingRatio = 0.9f,
        stiffness = 100f,
        visibilityThreshold = 0.001f
    )

    /** Accent color transition */
    val SpecColorTransition = spring<Float>(
        dampingRatio = 0.95f,
        stiffness = 60f,
        visibilityThreshold = 0.001f
    )

    // =========================================================================
    // Tween Fallbacks (when reduced motion enabled)
    // =========================================================================

    private fun reducedTween(duration: Int): AnimationSpec<Float> = tween(
        durationMillis = duration,
        easing = { t -> 1f - (1f - t) * (1f - t) } // easeOutQuad
    )

    fun specOrReduced(spring: AnimationSpec<Float>, reducedDuration: Int, reducedMotion: Boolean): AnimationSpec<Float> =
        if (reducedMotion) reducedTween(reducedDuration) else spring

    // =========================================================================
    // Stagger / Orchestration
    // =========================================================================

    /** Delay between staggered entrance items */
    val StaggerDelay = 60L  // ms

    /** Max stagger delay (cap for long lists) */
    val MaxStaggerDelay = 400L

    /** Calculate staggered delay for index */
    fun staggerDelay(index: Int, itemCount: Int): Long {
        val delay = index.toLong() * StaggerDelay
        return delay.coerceAtMost(MaxStaggerDelay)
    }

    /** Entrance sequence delays for main UI elements */
    object EntranceSequence {
        val SceneBackground = 0L
        val SceneParticles = 150L
        val GlassPanels = 200L
        val Sidebar = 280L
        val HeroButton = 360L
        val Content = 420L
    }

    // =========================================================================
    // Geometry / Spatial
    // =========================================================================

    /** Corner radius scale */
    object Radius {
        val Small = 8.dp
        val Medium = 12.dp
        val Large = 18.dp
        val XLarge = 24.dp
        val Full = 9999.dp
        val GlassCard = 16.dp
        val GlassButton = 12.dp
        val GlassPanel = 20.dp
    }

    /** Elevation shadows (subtle, not gaming-glow) */
    object Elevation {
        val Level0 = 0.dp
        val Level1 = 1.dp   // Resting card
        val Level2 = 4.dp   // Hovered card
        val Level3 = 8.dp   // Elevated panel
        val Level4 = 16.dp  // Modal, dropdown
        val Level5 = 32.dp  // Tooltip, popover
    }

    /** Spacing scale (8pt base) */
    object Spacing {
        val XS = 4.dp
        val SM = 8.dp
        val MD = 16.dp
        val LG = 24.dp
        val XL = 32.dp
        val XXL = 48.dp
        val XXXL = 64.dp
    }

    /** Glass border width */
    object Border {
        val Hairline = 0.5.dp
        val Thin = 1.dp
        val Medium = 1.5.dp
        val Thick = 2.dp
    }
}

/**
 * Reduced motion state holder - checked globally
 */
class ReducedMotionState(private val initial: Boolean = false) {
    private var _enabled = initial
    var enabled: Boolean
        get() = _enabled
        set(value) {
            _enabled = value
            onChange?.invoke(value)
        }
    var onChange: ((Boolean) -> Unit)? = null
}

/** Global instance - initialized from system settings at startup */
val reducedMotionState = ReducedMotionState()