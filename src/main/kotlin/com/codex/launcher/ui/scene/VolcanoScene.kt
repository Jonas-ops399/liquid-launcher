package com.codex.launcher.ui.scene

import androidx.compose.ui.graphics.Color
import kotlinx.serialization.Serializable

/**
 * Volcano Scene Preset
 *
 * Visual: Active volcano with flowing lava, rising smoke, falling ash
 * Layers: Sky → Volcano Mountain → Lava Flow → Smoke → Ash Particles → Glow
 *
 * Animation Techniques:
 * - Lava: Fragment shader with noise-based flow + thermal color ramp
 * - Smoke: Lottie animation (rising, dissolving plumes)
 * - Ash: CPU particle system (falling, drifting embers)
 * - Glow: Additive bloom on lava areas
 */
object VolcanoScene {

    private const val SCENE_ID = "volcano"

    fun register() {
        SceneRegistry.register(buildScene())
    }

    fun buildScene(): SceneDefinition {
        return SceneDefinition(
            id = SCENE_ID,
            name = "Vulkan",
            description = "Aktiver Vulkan mit Lavastrom, aufsteigendem Rauch und fallender Asche",
            layers = listOf(
                // Layer 0: Sky - Dark dramatic sky with subtle star hints
                SceneLayer(
                    id = "sky",
                    type = LayerType.SKY,
                    depth = 0.0f,
                    parallaxFactor = 0.05f,
                    assetPath = "scenes/volcano/sky.svg",
                    opacity = 1f,
                    filter = LayerFilter(saturate = 0.7f, brightness = 0.6f),
                ),

                // Layer 1: Far terrain - Distant mountains/horizon
                SceneLayer(
                    id = "far_mountains",
                    type = LayerType.FAR_TERRAIN,
                    depth = 0.15f,
                    parallaxFactor = 0.15f,
                    assetPath = "scenes/volcano/far_mountains.svg",
                    opacity = 0.85f,
                    filter = LayerFilter(blur = 2f, saturate = 0.5f),
                ),

                // Layer 2: Volcano mountain - Main structure
                SceneLayer(
                    id = "volcano_mountain",
                    type = LayerType.MID_TERRAIN,
                    depth = 0.35f,
                    parallaxFactor = 0.3f,
                    assetPath = "scenes/volcano/volcano_mountain.svg",
                    opacity = 1f,
                    animation = LayerAnimation(
                        type = AnimationType.SCALE,
                        durationMs = 8000,
                        parameters = mapOf("base" to "1.0", "range" to "0.005", "speed" to "0.15"),
                    ),
                ),

                // Layer 3: Lava flows - Shader-based animated lava
                SceneLayer(
                    id = "lava_flows",
                    type = LayerType.SHADER,
                    depth = 0.4f,
                    parallaxFactor = 0.35f,
                    assetPath = "lava_shader", // References shader snippet ID
                    opacity = 1f,
                    blendMode = BlendMode.Screen,
                    animation = LayerAnimation(
                        type = AnimationType.SHADER_UNIFORM,
                        durationMs = 0, // Continuous
                        parameters = mapOf(
                            "u_time" to "1.0",
                            "u_flowSpeed" to "0.8",
                            "u_noiseScale" to "3.5",
                        ),
                    ),
                ),

                // Layer 4: Lava glow - Additive bloom effect
                SceneLayer(
                    id = "lava_glow",
                    type = LayerType.GLOW,
                    depth = 0.42f,
                    parallaxFactor = 0.35f,
                    assetPath = "scenes/volcano/lava_glow.svg",
                    opacity = 0.6f,
                    blendMode = BlendMode.Plus,
                    animation = LayerAnimation(
                        type = AnimationType.OPACITY,
                        durationMs = 3000,
                        parameters = mapOf("base" to "0.5", "range" to "0.2", "speed" to "0.5"),
                    ),
                ),

                // Layer 5: Smoke plumes - Lottie animation
                SceneLayer(
                    id = "smoke",
                    type = LayerType.PARTICLES, // Rendered as Lottie
                    depth = 0.5f,
                    parallaxFactor = 0.4f,
                    assetPath = "scenes/volcano/smoke.lottie.json",
                    opacity = 0.75f,
                    blendMode = BlendMode.Screen,
                    animation = LayerAnimation(
                        type = AnimationType.LOTTIE,
                        durationMs = 12000,
                        loop = true,
                    ),
                ),

                // Layer 6: Ash particles - Falling embers/ash
                SceneLayer(
                    id = "ash_particles",
                    type = LayerType.PARTICLES,
                    depth = 0.6f,
                    parallaxFactor = 0.5f,
                    assetPath = "ash_particles", // CPU particle system
                    opacity = 0.6f,
                    blendMode = BlendMode.Normal,
                    animation = LayerAnimation(
                        type = AnimationType.PARTICLE_PHYSICS,
                        durationMs = 0,
                        parameters = mapOf(
                            "spawnRate" to "40",
                            "maxParticles" to "200",
                            "gravity" to "0.3",
                            "wind" to "0.15",
                            "lifetime" to "8.0",
                            "sizeRange" to "0.5,2.5",
                            "colorStart" to "#FF8800",
                            "colorEnd" to "#442200",
                        ),
                    ),
                ),

                // Layer 7: Foreground rocks/ground
                SceneLayer(
                    id = "foreground_rocks",
                    type = LayerType.FOREGROUND,
                    depth = 0.8f,
                    parallaxFactor = 0.8f,
                    assetPath = "scenes/volcano/foreground_rocks.svg",
                    opacity = 1f,
                ),

                // Layer 8: Ember sparkles near lava (additive)
                SceneLayer(
                    id = "ember_sparkles",
                    type = LayerType.GLOW,
                    depth = 0.85f,
                    parallaxFactor = 0.6f,
                    assetPath = "scenes/volcano/ember_sparkles.svg",
                    opacity = 0.4f,
                    blendMode = BlendMode.Plus,
                    animation = LayerAnimation(
                        type = AnimationType.OPACITY,
                        durationMs = 500,
                        parameters = mapOf("base" to "0.2", "range" to "0.3", "speed" to "8.0"),
                    ),
                ),
            ),
            shaders = listOf(
                lavaShader(),
                lavaGlowShader(),
            ),
            palette = ScenePalette(
                primary = "#FF6B1A",      // Lava orange
                secondary = "#FF3300",    // Deep lava red
                tertiary = "#FFCC00",     // Ember gold
                background = "#1A0A05",   // Dark volcanic
                onPrimary = "#FFFFFF",
                onSecondary = "#FFFFFF",
                onBackground = "#FFEEDD",
            ),
            previewThumbnail = "scenes/volcano/thumbnail.png",
        )
    }

    // =========================================================================
    // Shader Definitions
    // =========================================================================

    /**
     * Lava Flow Fragment Shader
     *
     * Features:
     * - FBM noise for organic flow patterns
     * - Thermal color ramp (black → dark red → bright orange → yellow → white)
     * - Flow direction with time-based offset
     * - Temperature-based emissive glow
     */
    private fun lavaShader(): ShaderSnippet {
        return ShaderSnippet(
            id = "lava_shader",
            type = ShaderType.FRAGMENT,
            fragmentSource = """
                #version 450
                #extension GL_EXT_shader_implicit_conversions : enable

                layout(set = 0, binding = 0) uniform Uniforms {
                    float u_time;
                    float u_flowSpeed;
                    float u_noiseScale;
                    vec2 u_resolution;
                    vec2 u_lavaRegion; // x=minY, y=maxY (normalized 0-1)
                };

                layout(location = 0) in vec2 v_texCoord;
                layout(location = 0) out vec4 outColor;

                // Hash function for noise
                float hash(vec2 p) {
                    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
                }

                // Value noise
                float noise(vec2 p) {
                    vec2 i = floor(p);
                    vec2 f = fract(p);
                    f = f * f * (3.0 - 2.0 * f); // Smoothstep
                    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
                }

                // Fractal Brownian Motion
                float fbm(vec2 p, int octaves) {
                    float value = 0.0;
                    float amplitude = 0.5;
                    float frequency = 1.0;
                    for (int i = 0; i < octaves; i++) {
                        value += amplitude * noise(p * frequency);
                        amplitude *= 0.5;
                        frequency *= 2.0;
                    }
                    return value;
                }

                // Thermal color ramp
                vec3 thermalColor(float t) {
                    // t: 0.0 (cold) to 1.0 (hottest)
                    if (t < 0.2) return mix(vec3(0.05, 0.0, 0.0), vec3(0.4, 0.0, 0.0), t * 5.0);
                    if (t < 0.4) return mix(vec3(0.4, 0.0, 0.0), vec3(1.0, 0.15, 0.0), (t - 0.2) * 5.0);
                    if (t < 0.6) return mix(vec3(1.0, 0.15, 0.0), vec3(1.0, 0.5, 0.0), (t - 0.4) * 5.0);
                    if (t < 0.8) return mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 0.9, 0.1), (t - 0.6) * 5.0);
                    return mix(vec3(1.0, 0.9, 0.1), vec3(1.0, 1.0, 0.9), (t - 0.8) * 5.0);
                }

                void main() {
                    vec2 uv = v_texCoord * u_noiseScale;

                    // Flow animation - offset UV over time
                    uv.y += u_time * u_flowSpeed * 0.15;

                    // Primary flow noise
                    float flow = fbm(uv + vec2(u_time * 0.03, 0.0), 5);

                    // Secondary turbulence
                    float turb = fbm(uv * 2.5 + vec2(u_time * 0.07, u_time * 0.04), 4);

                    // Combine for organic lava look
                    float heat = flow * 0.7 + turb * 0.3;

                    // Add vertical gradient (hotter at bottom/source)
                    float verticalBias = smoothstep(u_lavaRegion.y, u_lavaRegion.x, v_texCoord.y);
                    heat = mix(heat, heat * 0.6 + 0.4, verticalBias);

                    // Clamp and add slight variation
                    heat = clamp(heat, 0.0, 1.0);
                    heat = pow(heat, 1.2); // Contrast

                    vec3 color = thermalColor(heat);

                    // Emissive bloom for hottest parts
                    float bloom = smoothstep(0.75, 1.0, heat);
                    color += vec3(bloom * 0.3, bloom * 0.15, 0.0);

                    // Alpha based on heat (transparent when cool)
                    float alpha = smoothstep(0.15, 0.4, heat);

                    outColor = vec4(color, alpha);
                }
            """,
            uniforms = mapOf(
                "u_time" to ShaderUniform(UniformType.FLOAT, "0.0", animated = true, animationRange = 0f to 3600f, animationSpeed = 1f),
                "u_flowSpeed" to ShaderUniform(UniformType.FLOAT, "0.8"),
                "u_noiseScale" to ShaderUniform(UniformType.FLOAT, "3.5"),
                "u_resolution" to ShaderUniform(UniformType.VEC2, "1920,1080"),
                "u_lavaRegion" to ShaderUniform(UniformType.VEC2, "0.3,0.85"), // Lava flows in lower 55% of volcano
            ),
            targetLayers = listOf("lava_flows"),
        )
    }

    /**
     * Lava Glow Shader - Additive bloom for lava areas
     */
    private fun lavaGlowShader(): ShaderSnippet {
        return ShaderSnippet(
            id = "lava_glow_shader",
            type = ShaderType.FRAGMENT,
            fragmentSource = """
                #version 450

                layout(set = 0, binding = 0) uniform Uniforms {
                    float u_time;
                    vec2 u_resolution;
                };

                layout(location = 0) in vec2 v_texCoord;
                layout(location = 0) out vec4 outColor;

                float hash(vec2 p) {
                    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
                }

                float noise(vec2 p) {
                    vec2 i = floor(p);
                    vec2 f = fract(p);
                    f = f * f * (3.0 - 2.0 * f);
                    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
                }

                float fbm(vec2 p, int octaves) {
                    float value = 0.0;
                    float amplitude = 0.5;
                    float frequency = 1.0;
                    for (int i = 0; i < octaves; i++) {
                        value += amplitude * noise(p * frequency);
                        amplitude *= 0.5;
                        frequency *= 2.0;
                    }
                    return value;
                }

                void main() {
                    vec2 uv = v_texCoord * 4.0;
                    uv.y += u_time * 0.08;

                    float glow = fbm(uv + vec2(u_time * 0.02, 0.0), 4);
                    glow = pow(glow, 2.5); // Sharpen
                    glow = smoothstep(0.4, 0.8, glow); // Threshold

                    // Pulsing intensity
                    float pulse = 0.7 + 0.3 * sin(u_time * 2.5);
                    glow *= pulse;

                    // Radial falloff from center
                    float dist = length(v_texCoord - vec2(0.5, 0.65));
                    glow *= 1.0 - smoothstep(0.0, 0.45, dist);

                    vec3 color = vec3(1.0, 0.35, 0.05) * glow;
                    outColor = vec4(color, glow);
                }
            """,
            uniforms = mapOf(
                "u_time" to ShaderUniform(UniformType.FLOAT, "0.0", animated = true, animationSpeed = 1f),
                "u_resolution" to ShaderUniform(UniformType.VEC2, "1920,1080"),
            ),
            targetLayers = listOf("lava_glow"),
        )
    }
}

/**
 * Scene asset paths reference (for resource loading)
 */
object VolcanoAssets {
    const val SKY_SVG = "scenes/volcano/sky.svg"
    const val FAR_MOUNTAINS_SVG = "scenes/volcano/far_mountains.svg"
    const val VOLCANO_MOUNTAIN_SVG = "scenes/volcano/volcano_mountain.svg"
    const val LAVA_GLOW_SVG = "scenes/volcano/lava_glow.svg"
    const val SMOKE_LOTTIE = "scenes/volcano/smoke.lottie.json"
    const val FOREGROUND_ROCKS_SVG = "scenes/volcano/foreground_rocks.svg"
    const val EMBER_SPARKLES_SVG = "scenes/volcano/ember_sparkles.svg"
    const val THUMBNAIL = "scenes/volcano/thumbnail.png"
}

/**
 * Particle configuration for ash/embers
 */
data class VolcanoParticleConfig(
    val spawnRate: Int = 40,           // Particles per second
    val maxParticles: Int = 200,
    val gravity: Float = 0.3f,         // Downward acceleration
    val wind: Float = 0.15f,           // Horizontal drift
    val lifetime: Float = 8.0f,        // Seconds
    val sizeMin: Float = 0.5f,
    val sizeMax: Float = 2.5f,
    val colorStart: Color = Color(0xFFFF8800), // Bright ember
    val colorEnd: Color = Color(0xFF442200),   // Dark ash
    val spawnRegion: Pair<Float, Float> = 0.2f to 0.85f, // Y range (normalized)
)