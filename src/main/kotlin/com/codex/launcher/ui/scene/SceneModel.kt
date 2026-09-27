package com.codex.launcher.ui.scene

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import kotlinx.serialization.Serializable

/**
 * Scene Rendering Data Models
 *
 * Defines the layered scene architecture:
 * - Each scene has multiple depth layers (sky → foreground → particles)
 * - Layers have parallax speeds for depth perception
 * - Shaders for procedural effects (water, lava, aurora)
 * - Lottie animations for complex motion
 */
@Serializable
data class SceneDefinition(
    val id: String,
    val name: String,
    val description: String,
    val layers: List<SceneLayer>,
    val shaders: List<ShaderSnippet> = emptyList(),
    val palette: ScenePalette,
    val previewThumbnail: String, // resource path
)

@Serializable
data class SceneLayer(
    val id: String,
    val type: LayerType,
    val depth: Float,              // 0.0 (far) to 1.0 (near)
    val parallaxFactor: Float = 0f, // 0 = static, 1 = full mouse follow
    val assetPath: String,          // SVG, Lottie, or shader reference
    val opacity: Float = 1f,
    val blendMode: BlendMode = BlendMode.Normal,
    val animation: LayerAnimation? = null,
    val filter: LayerFilter? = null,
)

enum class LayerType {
    SKY,              // Gradient, skybox, stars
    FAR_TERRAIN,      // Mountains, horizon, distant land
    MID_TERRAIN,      // Trees, structures, mid-ground
    FOREGROUND,       // Rocks, grass, details
    PARTICLES,        // Rain, snow, spores, ash, plankton
    GLOW,             // Light effects, aurora, lava glow
    SHADER,           // Procedural (water caustics, lava flow)
}

@Serializable
data class LayerAnimation(
    val type: AnimationType,
    val durationMs: Long,
    val loop: Boolean = true,
    val easing: String = "linear",
    val parameters: Map<String, String> = emptyMap(),
)

enum class AnimationType {
    TRANSLATE,        // Position offset over time
    SCALE,            // Scale pulsing
    ROTATE,           // Rotation
    OPACITY,          // Fade pulse
    PATH,             // Follow SVG path
    SHADER_UNIFORM,   // Update shader uniform (time, flow)
    LOTTIE,           // Lottie animation frame
    PARTICLE_PHYSICS, // Physics-based particles
}

@Serializable
data class LayerFilter(
    val blur: Float = 0f,
    val saturate: Float = 1f,
    val brightness: Float = 1f,
    val contrast: Float = 1f,
)

enum class BlendMode {
    Normal, Multiply, Screen, Overlay, Plus, Lighten, Darken
}

@Serializable
data class ShaderSnippet(
    val id: String,
    val type: ShaderType,
    val vertexSource: String? = null,
    val fragmentSource: String,
    val uniforms: Map<String, ShaderUniform> = emptyMap(),
    val targetLayers: List<String> = emptyList(), // Layer IDs this shader applies to
)

enum class ShaderType {
    FRAGMENT,     // Pixel shader
    VERTEX_FRAGMENT, // Both
    COMPUTE,      // Compute shader (for particles)
}

@Serializable
data class ShaderUniform(
    val type: UniformType,
    val defaultValue: String,
    val animated: Boolean = false,
    val animationRange: Pair<Float, Float>? = null,
    val animationSpeed: Float = 1f,
)

enum class UniformType {
    FLOAT, VEC2, VEC3, VEC4, MAT2, MAT3, MAT4, INT, BOOL, SAMPLER2D
}

@Serializable
data class ScenePalette(
    val primary: String,       // Hex color
    val secondary: String,
    val tertiary: String,
    val background: String,
    val onPrimary: String = "#FFFFFF",
    val onSecondary: String = "#FFFFFF",
    val onBackground: String = "#FFFFFF",
) {
    fun toColorPalette(): com.codex.launcher.ui.design.ScenePalette {
        return com.codex.launcher.ui.design.ScenePalette(
            primary = Color(this.primary),
            secondary = Color(this.secondary),
            tertiary = Color(this.tertiary),
            background = Color(this.background),
            onPrimary = Color(this.onPrimary),
            onSecondary = Color(this.onSecondary),
            onBackground = Color(this.onBackground),
        )
    }
}

/**
 * Runtime scene state for rendering
 */
data class SceneRenderState(
    val time: Float = 0f,                    // Global time in seconds
    val deltaTime: Float = 0f,               // Frame delta
    val mouseOffset: Offset = Offset.Zero,   // Normalized -1..1
    val size: Size = Size.Zero,
    val reducedMotion: Boolean = false,
    val layerStates: Map<String, LayerRenderState> = emptyMap(),
)

data class LayerRenderState(
    val offset: Offset = Offset.Zero,
    val scale: Float = 1f,
    val rotation: Float = 0f,
    val opacity: Float = 1f,
    val shaderUniforms: Map<String, Float> = emptyMap(),
    val lottieProgress: Float = 0f,
)

/**
 * Scene registry - loads all built-in scenes
 */
object SceneRegistry {
    private val scenes = mutableMapOf<String, SceneDefinition>()

    fun register(scene: SceneDefinition) {
        scenes[scene.id] = scene
    }

    fun get(id: String): SceneDefinition? = scenes[id]
    fun all(): List<SceneDefinition> = scenes.values.toList()
    fun ids(): List<String> = scenes.keys.toList()

    fun loadBuiltIns() {
        // Will be called at startup to load all 20 scenes
        // For now, register Volcano as prototype
        VolcanoScene.register()
    }
}