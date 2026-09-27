package com.codex.launcher.ui.design

import androidx.compose.ui.graphics.Color

/**
 * Liquid Glass Color System
 *
 * Based on Apple's Liquid Glass design language:
 * - Translucent white surfaces with subtle blur
 * - Colored edge reflections
 * - Top sheen highlight
 * - Deep spatial layering
 */
object GlassColors {

    // =========================================================================
    // Base Glass Surface Colors
    // =========================================================================

    /** Primary glass background: rgba(255, 255, 255, 0.08–0.15) */
    val GlassBgPrimary = Color(0xFFFFFFFF, 0.12f)      // ~12% opacity
    val GlassBgSecondary = Color(0xFFFFFFFF, 0.08f)    // ~8% opacity (deeper)
    val GlassBgTertiary = Color(0xFFFFFFFF, 0.05f)     // ~5% opacity (subtle)

    /** Glass border: subtle white edge reflection */
    val GlassBorderPrimary = Color(0xFFFFFFFF, 0.18f)   // Main edge
    val GlassBorderSecondary = Color(0xFFFFFFFF, 0.10f) // Subtle inner edge
    val GlassBorderHover = Color(0xFFFFFFFF, 0.30f)     // Hover state

    /** Top sheen highlight (catches light from above) */
    val GlassSheen = Color(0xFFFFFFFF, 0.06f)          // Top 1px highlight
    val GlassSheenStrong = Color(0xFFFFFFFF, 0.12f)    // Pressed/focused

    // =========================================================================
    // Semantic Content Colors (on glass)
    // =========================================================================

    val ContentPrimary = Color(0xFFFFFFFF, 0.95f)       // Main text
    val ContentSecondary = Color(0xFFFFFFFF, 0.70f)     // Secondary text
    val ContentTertiary = Color(0xFFFFFFFF, 0.45f)      // Disabled/muted
    val ContentInverse = Color(0xFF000000, 0.85f)       // On light accents

    // =========================================================================
    // Accent Colors (derived from scene presets)
    // =========================================================================

    /** Default accent - Meteor Client blue */
    val AccentDefault = Color(0xFF50B4FF)               // #50B4FF from fabric.mod.json
    val AccentDefaultContainer = Color(0xFF50B4FF, 0.15f)
    val AccentDefaultOn = Color.White

    /** Preset-specific accents (updated dynamically) */
    var AccentCurrent: Color = AccentDefault
        @Suppress("UNUSED_PARAMETER") set(value) { field = value }
    var AccentCurrentContainer: Color = AccentDefaultContainer
        @Suppress("UNUSED_PARAMETER") set(value) { field = value }
    var AccentCurrentOn: Color = AccentDefaultOn
        @Suppress("UNUSED_PARAMETER") set(value) { field = value }

    // =========================================================================
    // State Colors
    // =========================================================================

    val Success = Color(0xFF4CAF50)
    val SuccessContainer = Color(0xFF4CAF50, 0.15f)
    val Warning = Color(0xFFFFC107)
    val WarningContainer = Color(0xFFFFC107, 0.15f)
    val Error = Color(0xFFF44336)
    val ErrorContainer = Color(0xFFF44336, 0.15f)
    val Info = Color(0xFF2196F3)
    val InfoContainer = Color(0xFF2196F3, 0.15f)

    // =========================================================================
    // Shadow & Elevation
    // =========================================================================

    /** Subtle shadow for depth (not heavy gaming-glow) */
    val ShadowLevel1 = Color(0xFF000000, 0.08f)  // Card resting
    val ShadowLevel2 = Color(0xFF000000, 0.12f)  // Card elevated
    val ShadowLevel3 = Color(0xFF000000, 0.18f)  // Modal/panel
    val ShadowLevel4 = Color(0xFF000000, 0.25f)  // Dropdown/tooltip

    // =========================================================================
    // Scene Background Fallbacks (when no scene loaded)
    // =========================================================================

    val SceneFallbackDark = Color(0xFF0A0E17)      // Deep night
    val SceneFallbackGradientStart = Color(0xFF0D1426)
    val SceneFallbackGradientEnd = Color(0xFF1A1F3A)

    // =========================================================================
    // Helper Functions
    // =========================================================================

    /** Create accent container with given opacity */
    fun accentContainer(opacity: Float = 0.15f): Color = AccentCurrent.copy(alpha = opacity)

    /** Create glass bg with custom opacity */
    fun glassBg(opacity: Float): Color = Color.White.copy(alpha = opacity.coerceIn(0.03f, 0.20f))

    /** Create glass border with custom opacity */
    fun glassBorder(opacity: Float): Color = Color.White.copy(alpha = opacity.coerceIn(0.05f, 0.35f))
}

/**
 * Dynamic color palette generated from a scene's dominant colors.
 * Used to adapt UI accents to the current preset.
 */
data class ScenePalette(
    val primary: Color,           // Dominant scene color
    val secondary: Color,         // Secondary scene color
    val tertiary: Color,          // Accent highlight
    val background: Color,        // Scene background average
    val onPrimary: Color = Color.White,
    val onSecondary: Color = Color.White,
    val onBackground: Color = Color.White,
) {
    fun toGlassAccents(): GlassAccents {
        return GlassAccents(
            accent = primary,
            accentContainer = primary.copy(alpha = 0.15f),
            accentOn = onPrimary,
            secondaryAccent = secondary,
            secondaryContainer = secondary.copy(alpha = 0.12f),
            highlight = tertiary,
        )
    }
}

data class GlassAccents(
    val accent: Color,
    val accentContainer: Color,
    val accentOn: Color,
    val secondaryAccent: Color,
    val secondaryContainer: Color,
    val highlight: Color,
)