package com.codex.launcher.ui.design

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Liquid Glass Typography System
 *
 * Geometric Sans-Serif in SF Pro / Inter style.
 * Variable font preferred for weight flexibility.
 * No pixel fonts except tiny Minecraft logo accents.
 */
object GlassTypography {

    // =========================================================================
    // Font Families
    // =========================================================================

    /** Primary UI font - Inter Variable (geometric, clean, excellent at all sizes) */
    val FontFamilyPrimary = FontFamily.Default  // Will be replaced with Inter Variable at runtime

    /** Display font - slightly wider, more geometric for hero elements */
    val FontFamilyDisplay = FontFamily.Default  // Will be replaced with Inter Variable / SF Pro Display

    /** Monospace for code, versions, technical data */
    val FontFamilyMono = FontFamily.Monospace

    // Font loading helper (call from Main after resources loaded)
    var fontLoader: (() -> Unit)? = null
    fun loadCustomFonts() = fontLoader?.invoke()

    // =========================================================================
    // Type Scale (Material 3 inspired, adjusted for Glass density)
    // =========================================================================

    // Display - Hero elements, page titles
    val DisplayLarge = TextStyle(
        fontFamily = FontFamilyDisplay,
        fontWeight = FontWeight(600),          // SemiBold
        fontSize = 56.sp,
        lineHeight = 64.sp,
        letterSpacing = -0.02.em,
    )

    val DisplayMedium = TextStyle(
        fontFamily = FontFamilyDisplay,
        fontWeight = FontWeight(600),
        fontSize = 44.sp,
        lineHeight = 52.sp,
        letterSpacing = -0.01.em,
    )

    val DisplaySmall = TextStyle(
        fontFamily = FontFamilyDisplay,
        fontWeight = FontWeight(500),          // Medium
        fontSize = 36.sp,
        lineHeight = 44.sp,
        letterSpacing = 0.em,
    )

    // Headline - Section headers, card titles
    val HeadlineLarge = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(600),
        fontSize = 30.sp,
        lineHeight = 38.sp,
        letterSpacing = 0.em,
    )

    val HeadlineMedium = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(600),
        fontSize = 24.sp,
        lineHeight = 32.sp,
        letterSpacing = 0.em,
    )

    val HeadlineSmall = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(600),
        fontSize = 20.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.em,
    )

    // Title - Card titles, list items
    val TitleLarge = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(500),
        fontSize = 18.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.em,
    )

    val TitleMedium = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(500),
        fontSize = 16.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.01.em,
    )

    val TitleSmall = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(500),
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.01.em,
    )

    // Body - Main reading text
    val BodyLarge = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(400),
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.01.em,
    )

    val BodyMedium = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(400),
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.02.em,
    )

    val BodySmall = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(400),
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.03.em,
    )

    // Label - Buttons, tabs, chips
    val LabelLarge = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(500),
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.02.em,
    )

    val LabelMedium = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(500),
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.05.em,
    )

    val LabelSmall = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(500),
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.05.em,
    )

    // =========================================================================
    // Special Styles
    // =========================================================================

    /** Hero "Play" button - prominent, geometric */
    val HeroButton = TextStyle(
        fontFamily = FontFamilyDisplay,
        fontWeight = FontWeight(600),
        fontSize = 20.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.02.em,
    )

    /** Sidebar navigation items */
    val SidebarItem = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(400),
        fontSize = 14.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.01.em,
    )

    /** Sidebar item - active state */
    val SidebarItemActive = SidebarItem.copy(fontWeight = FontWeight(500))

    /** Preset card title */
    val PresetTitle = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(500),
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.01.em,
    )

    /** Preset card description */
    val PresetDescription = TextStyle(
        fontFamily = FontFamilyPrimary,
        fontWeight = FontWeight(400),
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.03.em,
    )

    /** Tiny pixel accent (version numbers, Minecraft references) */
    val PixelTiny = TextStyle(
        fontFamily = FontFamilyMono,
        fontWeight = FontWeight(400),
        fontSize = 10.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.1.em,
    )

    // =========================================================================
    // Content Color Variants (applied via composition)
    // =========================================================================

    fun TextStyle.onPrimary(): TextStyle = this.copy(color = GlassColors.ContentPrimary)
    fun TextStyle.onSecondary(): TextStyle = this.copy(color = GlassColors.ContentSecondary)
    fun TextStyle.onTertiary(): TextStyle = this.copy(color = GlassColors.ContentTertiary)
    fun TextStyle.onAccent(): TextStyle = this.copy(color = GlassColors.AccentCurrentOn)
    fun TextStyle.onError(): TextStyle = this.copy(color = GlassColors.Error)
    fun TextStyle.onSuccess(): TextStyle = this.copy(color = GlassColors.Success)
    fun TextStyle.onWarning(): TextStyle = this.copy(color = GlassColors.Warning)

    // Weight variants
    fun TextStyle.medium(): TextStyle = this.copy(fontWeight = FontWeight(500))
    fun TextStyle.semiBold(): TextStyle = this.copy(fontWeight = FontWeight(600))
    fun TextStyle.bold(): TextStyle = this.copy(fontWeight = FontWeight(700))
}