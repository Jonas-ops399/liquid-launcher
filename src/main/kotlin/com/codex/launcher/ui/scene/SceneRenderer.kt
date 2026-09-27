package com.codex.launcher.ui.scene

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.pointerInput
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawRect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.px
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Scene Renderer Component
 *
 * Renders layered scenes with:
 * - Parallax mouse response
 * - Shader-based procedural effects
 * - Lottie animation integration
 * - Smooth cross-fade transitions
 * - 60fps target with drawWithCache optimization
 */
@Composable
fun SceneView(
    modifier: Modifier = Modifier,
    scene: SceneDefinition,
    onRenderState: (SceneRenderState) -> Unit = {},
    crossFadeProgress: Float = 1f, // 0 = previous scene, 1 = current scene
    previousScene: SceneDefinition? = null,
) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()

    // Global time animation
    val infiniteTransition = rememberInfiniteTransition(label = "sceneTime")
    val time by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 3600f, // 1 hour loop
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 3_600_000, easing = { it }),
            repeatMode = androidx.compose.animation.core.RepeatMode.Restart
        ),
        label = "globalTime"
    )

    // Mouse parallax tracking
    val mouseOffset = remember { androidx.compose.runtime.mutableStateOf(Offset.Zero) }

    // Render state
    val renderState = remember {
        SceneRenderState()
    }

    // Update render state each frame
    val frameJob = remember { Job() }
    androidx.compose.runtime.DisposableEffect(time) {
        frameJob.cancel()
        val newJob = scope.launch(Dispatchers.Main) {
            while (true) {
                val dt = 1f / 60f // Fixed timestep for consistency
                renderState.copy(
                    time = time,
                    deltaTime = dt,
                    mouseOffset = mouseOffset.value,
                    reducedMotion = false, // TODO: connect to global setting
                ).also { onRenderState(it) }
                kotlinx.coroutines.delay(16) // ~60fps
            }
        }
        onDispose { newJob.cancel() }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectDragGestures { _, _, _, _ -> }
                onPointerEvent { event ->
                    event.changes.firstOrNull()?.let { change ->
                        val bounds = this.boundsInRoot()
                        val centerX = bounds.center.x()
                        val centerY = bounds.center.y()
                        val normalizedX = ((change.position.x() - centerX) / (bounds.width / 2)).coerceIn(-1f, 1f)
                        val normalizedY = ((change.position.y() - centerY) / (bounds.height / 2)).coerceIn(-1f, 1f)
                        mouseOffset.value = Offset(normalizedX, normalizedY)
                    }
                }
            }
    ) {
        // Render current scene
        SceneLayerRenderer(
            scene = scene,
            renderState = renderState,
            alpha = crossFadeProgress,
        )

        // Render previous scene for cross-fade
        if (crossFadeProgress < 1f && previousScene != null) {
            SceneLayerRenderer(
                scene = previousScene,
                renderState = renderState,
                alpha = 1f - crossFadeProgress,
            )
        }
    }
}

/**
 * Renders all layers of a scene in depth order
 */
@Composable
private fun SceneLayerRenderer(
    scene: SceneDefinition,
    renderState: SceneRenderState,
    alpha: Float,
) {
    // Sort layers by depth (far to near)
    val sortedLayers = scene.layers.sortedBy { it.depth }

    sortedLayers.forEach { layer ->
        SceneLayerView(
            layer = layer,
            scene = scene,
            renderState = renderState,
            alpha = alpha,
        )
    }
}

/**
 * Individual layer renderer - handles SVG, Lottie, Shaders, Particles
 */
@Composable
private fun SceneLayerView(
    layer: SceneLayer,
    scene: SceneDefinition,
    renderState: SceneRenderState,
    alpha: Float,
) {
    val layerState = remember(layer.id) {
        LayerRenderState()
    }

    // Update layer animation state
    updateLayerState(layer, layerState, renderState)

    // Calculate parallax offset
    val parallaxOffset = Offset(
        renderState.mouseOffset.x * layer.parallaxFactor * 30f, // Max 30px offset
        renderState.mouseOffset.y * layer.parallaxFactor * 30f,
    )

    // Apply layer filter (blur, saturate, etc.)
    val filter = layer.filter

    Canvas(
        modifier = Modifier
            .fillMaxSize()
            .graphicsLayer {
                this.alpha = alpha * layer.opacity * layerState.opacity
                this.translationX = parallaxOffset.x + layerState.offset.x
                this.translationY = parallaxOffset.y + layerState.offset.y
                this.scaleX = layerState.scale
                this.scaleY = layerState.scale
                this.rotationZ = layerState.rotation
                // Blend mode would need custom DrawScope extension
            },
        onDraw = { drawScope ->
            when (layer.type) {
                LayerType.SHADER -> {
                    // Shader layers handled by ShaderRenderer
                    renderShaderLayer(drawScope, layer, scene, layerState, renderState)
                }
                LayerType.PARTICLES -> {
                    renderParticleLayer(drawScope, layer, layerState, renderState)
                }
                else -> {
                    // SVG/Lottie layers - draw cached asset
                    renderAssetLayer(drawScope, layer, layerState)
                }
            }
        },
    )
}

/**
 * Update layer animation state based on time and animation config
 */
private fun updateLayerState(
    layer: SceneLayer,
    state: LayerRenderState,
    renderState: SceneRenderState,
) {
    layer.animation?.let { anim ->
        val progress = (renderState.time * 1000 % anim.durationMs) / anim.durationMs.toFloat()
        val easedProgress = when (anim.easing) {
            "easeInOut" -> easeInOut(progress)
            "easeOut" -> easeOut(progress)
            "easeIn" -> easeIn(progress)
            else -> progress
        }

        when (anim.type) {
            AnimationType.TRANSLATE -> {
                val dx = anim.parameters["dx"]?.toFloatOrNull() ?: 0f
                val dy = anim.parameters["dy"]?.toFloatOrNull() ?: 0f
                state.offset = Offset(dx * easedProgress, dy * easedProgress)
            }
            AnimationType.SCALE -> {
                val base = anim.parameters["base"]?.toFloatOrNull() ?: 1f
                val range = anim.parameters["range"]?.toFloatOrNull() ?: 0.1f
                state.scale = base + range * sin(renderState.time * anim.parameters["speed"]?.toFloatOrNull() ?: 1f)
            }
            AnimationType.ROTATE -> {
                val speed = anim.parameters["speed"]?.toFloatOrNull() ?: 0.1f
                state.rotation = renderState.time * speed
            }
            AnimationType.OPACITY -> {
                val base = anim.parameters["base"]?.toFloatOrNull() ?: 1f
                val range = anim.parameters["range"]?.toFloatOrNull() ?: 0.3f
                state.opacity = base + range * sin(renderState.time * anim.parameters["speed"]?.toFloatOrNull() ?: 1f)
            }
            AnimationType.SHADER_UNIFORM -> {
                anim.parameters.forEach { (key, value) ->
                    val speed = value.toFloatOrNull() ?: 1f
                    state.shaderUniforms[key] = renderState.time * speed
                }
            }
            AnimationType.LOTTIE -> {
                state.lottieProgress = (progress * 100f).coerceIn(0f, 100f)
            }
            AnimationType.PARTICLE_PHYSICS -> {
                // Handled in particle renderer
            }
        }
    }
}

/**
 * Render shader-based layer (water, lava, aurora, etc.)
 */
private fun renderShaderLayer(
    drawScope: DrawScope,
    layer: SceneLayer,
    scene: SceneDefinition,
    layerState: LayerRenderState,
    renderState: SceneRenderState,
) {
    // Find matching shader snippet
    val shader = scene.shaders.firstOrNull { it.id == layer.assetPath || layer.assetPath in it.targetLayers }
    shader?.let {
        // In production: use Skia RuntimeEffect to compile and draw shader
        // For now, draw placeholder
        drawScope.drawRect(
            color = Color.Magenta.copy(alpha = 0.3f),
            size = drawScope.size,
        )
    }
}

/**
 * Render particle layer (rain, snow, spores, ash, plankton)
 */
private fun renderParticleLayer(
    drawScope: DrawScope,
    layer: SceneLayer,
    layerState: LayerRenderState,
    renderState: SceneRenderState,
) {
    // Particle rendering - in production uses compute shader or CPU particles
    // Draw placeholder
    drawScope.drawRect(
        color = Color.Cyan.copy(alpha = 0.2f * layerState.opacity),
        size = drawScope.size,
    )
}

/**
 * Render asset layer (SVG, Lottie)
 */
private fun renderAssetLayer(
    drawScope: DrawScope,
    layer: SceneLayer,
    layerState: LayerRenderState,
) {
    // Asset rendering - in production loads SVG/Lottie from resources
    // Draw placeholder
    drawScope.drawRect(
        color = Color.Yellow.copy(alpha = 0.15f * layerState.opacity),
        size = drawScope.size,
    )
}

// Easing functions
private fun easeInOut(t: Float): Float = if (t < 0.5f) 2f * t * t else 1f - (-2f * t + 2f).pow(2) / 2f
private fun easeOut(t: Float): Float = 1f - (1f - t).pow(2)
private fun easeIn(t: Float): Float = t * t

/**
 * Coroutine scope for scene animations
 */
private fun rememberCoroutineScope(): CoroutineScope {
    val scope = remember { kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main) }
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose { scope.cancel() }
    }
    return scope
}

/**
 * Cross-fade transition between scenes
 */
@Composable
fun SceneCrossFade(
    modifier: Modifier = Modifier,
    currentScene: SceneDefinition,
    previousScene: SceneDefinition?,
    progress: Float, // 0..1
    onComplete: (() -> Unit)? = null,
) {
    val animatedProgress = remember { androidx.compose.runtime.mutableStateOf(progress) }
    val targetProgress = remember { androidx.compose.runtime.mutableStateOf(progress) }

    // Animate to target
    androidx.compose.runtime.LaunchedEffect(targetProgress.value) {
        animatedProgress.value = targetProgress.value
        if (targetProgress.value == 1f) onComplete?.invoke()
    }

    SceneView(
        modifier = modifier,
        scene = currentScene,
        crossFadeProgress = animatedProgress.value,
        previousScene = previousScene,
    )
}