"""Daylight for the Cycles renders: HDRI sky + sun lamp, colour management, render settings, and
Cycles-only tuning of glass and metal materials.

The look we are after is the one of the marketing renders: a clear morning sky with some haze, the sun
from the east-south-east about 38 deg up, crisp but soft-edged shadows whose shadow side is lit by a
blue sky (not black), and glass that mostly reflects the sky and the surroundings with the rooms behind
it faintly visible.

* World.  The Poly Haven HDRI ``san_giuseppe_bridge_2k.hdr`` (CC0) lights the scene and is what the glass
  reflects.  It is turned about Z so that its sun lines up with our sun (see ``hdri_rotation``), its
  sun hotspot is clamped away (the sun lamp is the key light, so there is no double sun and no
  fireflies), and it is scaled so that its sky gives a fixed irradiance whatever the exposure of the
  photograph.  Camera rays do not see the HDRI (its horizon is a Venetian canal, which looks wrong behind
  our city); they see a clean, physically based sky (Blender's Sky Texture) with a hazy pale-blue
  horizon instead.
* Sun.  A sun lamp with the real sun's angular size, its strength set from a sun/sky irradiance ratio.
* Materials.  Glass becomes real thin glass in Cycles (low roughness, IOR 1.5, mostly transmissive with
  a tint) and lets shadow/diffuse rays through, so the rooms the facade puts behind the glass are lit
  and faintly visible.  Every change is recorded and ``restore_materials()`` undoes it, so the glTF
  export (which the web viewer reads) keeps the materials exactly as ``materials.py`` made them.
"""
import math
import os

import bpy
import numpy as np
from mathutils import Vector

HDRI_PATH = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'hdri',
                                          'san_giuseppe_bridge_2k.hdr'))

# our sun: compass azimuth (from north, clockwise) and elevation, degrees
SUN_AZ, SUN_EL = 112.0, 38.0
SUN_ANGLE = 0.55            # angular diameter of the sun disc, deg (the real sun is 0.53 deg)
SUN_COLOR = (1.0, 0.925, 0.83)   # ~5600 K morning sun; a bit less warm than the HDRI's own sun

# Irradiance budget (Blender units: a sun lamp of strength S gives irradiance S on a surface facing it,
# a uniform background of radiance L gives pi * L on a horizontal surface).
SKY_E = 1.0                 # horizontal irradiance from the (clamped) HDRI sky, above the horizon
SUN_SKY_RATIO = 2.6         # horizontal irradiance sun / sky (a real clear sky at 38 deg is ~4-6; the renders are softer)
SUN_CLAMP = 2.2             # HDRI radiance clamp (after scaling): cuts the sun and its inner aureole
CAMERA_SKY_STRENGTH = 0.06  # Sky Texture strength for camera rays (zenith matched to the HDRI's zenith)
CAMERA_SKY_AEROSOL = 1.0    # haze of the camera sky: higher = paler, brighter horizon

# Exposure / view transform (chosen against images/1.jpg, see the before/after renders)
VIEW_TRANSFORM = 'AgX'
LOOK = 'AgX - Medium High Contrast'
EXPOSURE = 0.3

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


# ----------------------------------------------------------------------------------------------
# HDRI measurement and orientation
# ----------------------------------------------------------------------------------------------

def measure_hdri(img):
    """Find the sun in an equirectangular HDRI and the sky's irradiance (numpy on the pixels).

    Returns dict(u, v) of the sun (image fractions, v from the bottom row, as Blender stores pixels),
    its elevation, the sky's horizontal irradiance (luminance, sun excluded, above the horizon only),
    the sun's own normal irradiance and colour, all in the HDRI's units.

    For san_giuseppe_bridge_2k.hdr (2048 x 1024) this finds the sun disc centred on pixel column
    1227.6, row 674.3 from the bottom (peak luminance ~77000), i.e. u = 0.5994, v = 0.6585: elevation
    (v - 0.5) * 180 = 28.5 deg, and 0.0994 of a turn = 35.8 deg to the right of the image centre.  The
    sky (sun excluded) gives a horizontal irradiance of ~2.0 and the sun ~2.2 (the HDRI's sun is weak
    against its sky; we set the ratio ourselves with the lamp)."""
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[:, :, :3]
    lum = px @ LUMA
    el = ((np.arange(h) + 0.5) / h - 0.5) * math.pi            # elevation of each pixel row
    d_omega = (2 * math.pi / w) * (math.pi / h) * np.cos(el)   # solid angle of a pixel in that row
    iy, ix = np.unravel_index(int(np.argmax(lum)), lum.shape)
    # sun: pixels within ~4 deg of the peak that are brighter than 0.5 % of it; luminance-weighted centroid
    r = max(3, int(round(4.0 / 360.0 * w)))
    y0, y1, x0, x1 = max(0, iy - r), min(h, iy + r + 1), max(0, ix - r), min(w, ix + r + 1)
    win = lum[y0:y1, x0:x1]
    m = win > lum[iy, ix] * 0.005
    ys, xs = np.nonzero(m)
    wts = win[m]
    cy = y0 + (ys * wts).sum() / wts.sum() + 0.5
    cx = x0 + (xs * wts).sum() / wts.sum() + 0.5
    sun_mask = np.zeros_like(lum, dtype=bool)
    sun_mask[y0:y1, x0:x1] = m
    sun_rgb = (px * (d_omega[:, None] * sun_mask)[..., None]).reshape(-1, 3).sum(0)
    up = (el > 0)[:, None] & ~sun_mask
    sky_e = float((lum * (d_omega * np.clip(np.sin(el), 0, None))[:, None] * up).sum())
    return dict(u=cx / w, v=cy / h, elevation=math.degrees((cy / h - 0.5) * math.pi),
                sky_irradiance=sky_e, sun_irradiance=float(sun_rgb @ LUMA),
                sun_color=tuple(sun_rgb / max(sun_rgb.max(), 1e-9)), peak=float(lum[iy, ix]))


def compass_to_math(az_deg):
    """Compass azimuth (from +Y = north, clockwise) -> angle in the XY plane from +X, counter-clockwise."""
    return 90.0 - az_deg


def hdri_rotation(sun_u, sun_az=SUN_AZ):
    """Z rotation (radians) of the Mapping node that puts the HDRI's sun at compass azimuth ``sun_az``.

    Cycles looks an equirectangular image up from the ray direction d (world space, after the Mapping
    node) as  u = 0.5 - atan2(d.y, d.x) / 2pi,  v = 0.5 + asin(d.z) / pi   (u = 0.5 looks along +X).
    So the HDRI's sun sits at texture-space angle  phi_img = 2pi (0.5 - u_sun)  in the XY plane.
    The Mapping node (type POINT) rotates the world direction before the look-up:  d_tex = Rz(theta) d.
    Our sun direction has angle  phi_sun = 90 deg - azimuth;  we want Rz(theta) d_sun to land on the
    HDRI's sun, so  theta = phi_img - phi_sun.
    For this HDRI: u = 0.5994 -> phi_img = -35.8 deg; azimuth 112 -> phi_sun = -22 deg; theta = -13.8 deg.
    (The HDRI's sun is 28.5 deg up, ours 38: only the azimuth is matched; tilting would tilt the horizon.)
    """
    phi_img = 2.0 * math.pi * (0.5 - sun_u)
    phi_sun = math.radians(compass_to_math(sun_az))
    return phi_img - phi_sun


def sun_vector(az=SUN_AZ, el=SUN_EL):
    """Unit vector towards the sun (x east, y north, z up)."""
    a, e = math.radians(az), math.radians(el)
    return Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))


# ----------------------------------------------------------------------------------------------
# World, sun, render settings
# ----------------------------------------------------------------------------------------------

def _node(nt, kind, name=None, loc=(0, 0)):
    n = nt.nodes.new(kind)
    if name:
        n.name = n.label = name
    n.location = loc
    return n


def setup_world(scene, hdri_path=HDRI_PATH):
    """HDRI for lighting and reflections, a clean sky for camera rays. Returns the HDRI measurement."""
    old = bpy.data.worlds.get('Sky')
    if old is not None:
        old.name = 'Sky (old)'
    world = bpy.data.worlds.new('Sky')
    scene.world = world
    try:
        world.use_nodes = True       # still needed before Blender 6
    except AttributeError:
        pass
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    L = nt.links.new
    out = _node(nt, 'ShaderNodeOutputWorld', 'World Output', (1200, 0))

    meas = None
    img = None
    if os.path.exists(hdri_path):
        img = bpy.data.images.load(hdri_path, check_existing=True)
        meas = measure_hdri(img)

    # --- lighting / reflection environment: rotated, clamped, normalised HDRI
    light_bg = _node(nt, 'ShaderNodeBackground', 'HDRI light', (900, 120))
    if meas is not None:
        tc = _node(nt, 'ShaderNodeTexCoord', None, (0, 200))
        mp = _node(nt, 'ShaderNodeMapping', 'HDRI rotation', (200, 200))
        mp.inputs['Rotation'].default_value[2] = hdri_rotation(meas['u'])
        env = _node(nt, 'ShaderNodeTexEnvironment', 'HDRI', (400, 200))
        env.image = img
        env.interpolation = 'Linear'
        k = SKY_E / max(meas['sky_irradiance'], 1e-6)       # sky irradiance -> SKY_E
        scale = _node(nt, 'ShaderNodeVectorMath', 'HDRI scale', (650, 200))
        scale.operation = 'SCALE'
        scale.inputs['Scale'].default_value = k
        clamp = _node(nt, 'ShaderNodeVectorMath', 'Clamp sun', (800, 200))
        clamp.operation = 'MINIMUM'
        clamp.inputs[1].default_value = (SUN_CLAMP, SUN_CLAMP, SUN_CLAMP)
        L(tc.outputs['Generated'], mp.inputs['Vector'])
        L(mp.outputs['Vector'], env.inputs['Vector'])
        L(env.outputs['Color'], scale.inputs[0])
        L(scale.outputs['Vector'], clamp.inputs[0])
        L(clamp.outputs['Vector'], light_bg.inputs['Color'])
        light_bg.inputs['Strength'].default_value = 1.0
        world['hdri'] = os.path.basename(hdri_path)
        world['hdri_rotation_deg'] = math.degrees(hdri_rotation(meas['u']))
        world['hdri_scale'] = k
    else:  # no HDRI on disk: a plain blue-grey sky so the build still renders
        light_bg.inputs['Color'].default_value = (0.32, 0.42, 0.6, 1.0)
        light_bg.inputs['Strength'].default_value = SKY_E / math.pi

    # --- what the camera sees: physically based clear sky with a hazy horizon, no sun disc
    sky = _node(nt, 'ShaderNodeTexSky', 'Camera sky', (400, -200))
    try:
        sky.sky_type = 'MULTIPLE_SCATTERING'
    except TypeError:
        sky.sky_type = 'NISHITA'
    sky.sun_disc = False
    sky.sun_elevation = math.radians(SUN_EL)
    sky.sun_rotation = sky_rotation()
    sky.altitude = 0.0
    sky.air_density = 1.0
    sky.aerosol_density = CAMERA_SKY_AEROSOL
    sky.ozone_density = 1.0
    # below the horizon (past the end of the site's ground) the camera sees the hazy horizon colour of
    # a few degrees up instead of the sky texture's black ground: direction z -> max(z, sin 3 deg)
    tc2 = _node(nt, 'ShaderNodeTexCoord', None, (-200, -200))
    sep = _node(nt, 'ShaderNodeSeparateXYZ', None, (0, -200))
    zmax = _node(nt, 'ShaderNodeMath', 'Horizon floor', (150, -260))
    zmax.operation = 'MAXIMUM'
    zmax.inputs[1].default_value = math.sin(math.radians(3.0))
    comb = _node(nt, 'ShaderNodeCombineXYZ', None, (250, -200))
    norm = _node(nt, 'ShaderNodeVectorMath', None, (300, -200))
    norm.operation = 'NORMALIZE'
    L(tc2.outputs['Generated'], sep.inputs[0])
    L(sep.outputs['X'], comb.inputs['X'])
    L(sep.outputs['Y'], comb.inputs['Y'])
    L(sep.outputs['Z'], zmax.inputs[0])
    L(zmax.outputs[0], comb.inputs['Z'])
    L(comb.outputs['Vector'], norm.inputs[0])
    L(norm.outputs['Vector'], sky.inputs['Vector'])
    cam_bg = _node(nt, 'ShaderNodeBackground', 'Camera sky bg', (900, -120))
    L(sky.outputs['Color'], cam_bg.inputs['Color'])
    cam_bg.inputs['Strength'].default_value = CAMERA_SKY_STRENGTH

    lp = _node(nt, 'ShaderNodeLightPath', None, (700, 400))
    mix = _node(nt, 'ShaderNodeMixShader', 'Camera or light', (1050, 0))
    L(lp.outputs['Is Camera Ray'], mix.inputs['Fac'])
    L(light_bg.outputs['Background'], mix.inputs[1])
    L(cam_bg.outputs['Background'], mix.inputs[2])
    L(mix.outputs['Shader'], out.inputs['Surface'])
    return meas


def sky_rotation():
    """Sky Texture sun_rotation for our sun azimuth.  Blender's sky puts the sun at
    rotation 0 towards +Y and turns it clockwise seen from above (like a compass) -- verified by
    rendering the sky with the camera looking at sun_vector()."""
    return math.radians(SUN_AZ)


def setup_sun(scene, meas=None):
    old = bpy.data.objects.get('Sun')
    if old is not None:
        bpy.data.objects.remove(old)
    sun_data = bpy.data.lights.new('Sun', 'SUN')
    # horizontal irradiance of the lamp = strength * sin(el) = SUN_SKY_RATIO * SKY_E
    sun_data.energy = SUN_SKY_RATIO * SKY_E / math.sin(math.radians(SUN_EL))
    sun_data.angle = math.radians(SUN_ANGLE)
    sun_data.color = SUN_COLOR
    sun = bpy.data.objects.new('Sun', sun_data)
    scene.collection.objects.link(sun)
    d = -sun_vector()          # light travels away from the sun
    sun.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return sun


def setup_render(scene, scale, samples):
    scene.render.engine = 'CYCLES'
    c = scene.cycles
    c.device = 'CPU'
    c.samples = samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.02 if samples < 64 else 0.01
    c.adaptive_min_samples = 0
    c.use_denoising = True
    try:
        c.denoiser = 'OPENIMAGEDENOISE'
        c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
        c.denoising_prefilter = 'ACCURATE'
    except (TypeError, AttributeError):
        pass
    # glass needs transmission depth (pane + far pane), alpha railings and leaf cards need transparent depth
    c.max_bounces = 10
    c.diffuse_bounces = 3
    c.glossy_bounces = 4
    c.transmission_bounces = 6
    c.transparent_max_bounces = 16
    c.volume_bounces = 0
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.blur_glossy = 1.0
    c.sample_clamp_direct = 0.0
    c.sample_clamp_indirect = 4.0     # kills fireflies from glossy paths to the sky near the sun
    c.filter_width = 1.5
    c.use_light_tree = True
    scene.render.resolution_percentage = max(1, int(round(scale * 100)))
    scene.render.film_transparent = False
    vs = scene.view_settings
    try:
        vs.view_transform = VIEW_TRANSFORM
        vs.look = LOOK
    except TypeError:
        vs.view_transform = 'Standard'
        vs.look = 'None'
    vs.exposure = EXPOSURE
    vs.gamma = 1.0


# ----------------------------------------------------------------------------------------------
# Cycles-only material tuning (reversible)
# ----------------------------------------------------------------------------------------------

# glass: share = transmissive share (the rest is the reflective body with the base colour), rough =
# roughness, tint = gamma of the transmission tint (base ** tint, lighter than the base colour),
# spec = Specular IOR Level (0.5 = plain IOR 1.5 glass, F0 4 %; higher = coated architectural glass)
GLASS = {
    'Window glass': dict(share=0.75, rough=0.03, tint=0.6, spec=None),
    'Curtain glass': dict(share=0.75, rough=0.025, tint=0.6, spec=None),
    'Shop glass': dict(share=0.75, rough=0.03, tint=0.6, spec=None),
    'Shop window': dict(share=0.85, rough=0.035, tint=1.0, spec=None),
    'Gallery glass': dict(share=0.85, rough=0.04, tint=1.0, spec=None),
}
GLASS_DAYLIGHT = 0.5    # visible transmittance of the panes for light going into the rooms
# other shading-only tweaks: name -> {input: value}
SHADING = {
    'Metal': {'Metallic': 1.0, 'Roughness': 0.32},
    'Shop frame': {'Metallic': 0.85, 'Roughness': 0.38},
    'Lamp white': {'Roughness': 0.38},
    'Solar panel': {'Roughness': 0.35, 'Metallic': 0.2, 'Coat Weight': 1.0, 'Coat Roughness': 0.02},
    'Car': {'Metallic': 0.6, 'Roughness': 0.35, 'Coat Weight': 1.0, 'Coat Roughness': 0.03},
    'Car dark': {'Metallic': 0.6, 'Roughness': 0.35, 'Coat Weight': 1.0, 'Coat Roughness': 0.03},
    'Car red': {'Metallic': 0.4, 'Roughness': 0.4, 'Coat Weight': 1.0, 'Coat Roughness': 0.03},
    'Pool water': {'Roughness': 0.02, 'IOR': 1.33},
}
_TAG = 'LT '          # name prefix of the nodes this module adds
_ORIG = {}            # material name -> dict(inputs={name: value}, surface=socket or None)


def _remember(m, bsdf, name):
    rec = _ORIG.setdefault(m.name, dict(inputs={}, surface=None))
    if name not in rec['inputs']:
        v = bsdf.inputs[name].default_value
        rec['inputs'][name] = tuple(v) if hasattr(v, '__len__') else v


def _set(m, bsdf, name, value):
    if name in bsdf.inputs:
        _remember(m, bsdf, name)
        bsdf.inputs[name].default_value = value


def _output(m):
    outs = [n for n in m.node_tree.nodes if n.bl_idname == 'ShaderNodeOutputMaterial']
    act = [n for n in outs if n.is_active_output]
    return (act or outs or [None])[0]


def tune_glass(m, share, rough, tint, spec=None):
    """Real thin glass for Cycles: Fresnel reflections dominate at grazing angles, the room behind is
    faintly visible through a tint (base colour ** tint, lighter than the base colour, which stays
    as the glass's body colour), shadow and diffuse rays pass so rooms behind the glass are lit, and a
    ray that already came in through glass sees the far glass as dark interior (empty floors read as
    dark rooms, not as see-through buildings)."""
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    out = _output(m)
    if bsdf is None or out is None or nt.nodes.get(_TAG + 'glass') is not None:
        return
    link = out.inputs['Surface'].links
    if not link or link[0].from_node.name != bsdf.name:
        return                        # someone built a custom shader: leave it alone
    _ORIG.setdefault(m.name, dict(inputs={}, surface=None))['surface'] = bsdf.name
    roughness, transmission = rough, share
    _set(m, bsdf, 'Roughness', roughness)
    _set(m, bsdf, 'IOR', 1.5)
    if spec is not None:
        _set(m, bsdf, 'Specular IOR Level', spec)
    _set(m, bsdf, 'Transmission Weight', 0.0)      # body: reflective, with the base colour
    _set(m, bsdf, 'Alpha', 1.0)
    base = tuple(bsdf.inputs['Base Color'].default_value)
    tint = tuple(max(0.0, c) ** tint for c in base[:3]) + (1.0,)
    N = lambda kind, name, x, y: _node(nt, kind, _TAG + name, (x, y))   # noqa: E731
    pane = N('ShaderNodeBsdfPrincipled', 'pane', bsdf.location.x, bsdf.location.y - 700)
    pane.inputs['Base Color'].default_value = tint
    pane.inputs['Roughness'].default_value = roughness
    pane.inputs['IOR'].default_value = 1.5
    pane.inputs['Transmission Weight'].default_value = 1.0
    pane.inputs['Specular IOR Level'].default_value = bsdf.inputs['Specular IOR Level'].default_value
    if 'Thin Wall' in pane.inputs:
        pane.inputs['Thin Wall'].default_value = True
    body = N('ShaderNodeMixShader', 'body/pane', out.location.x - 600, out.location.y)
    body.inputs['Fac'].default_value = transmission
    nt.links.new(bsdf.outputs['BSDF'], body.inputs[1])
    nt.links.new(pane.outputs['BSDF'], body.inputs[2])
    # rays that already went through glass: the far pane is the dark back of the room
    lp = N('ShaderNodeLightPath', 'light path', out.location.x - 900, out.location.y + 400)
    inside = N('ShaderNodeMath', 'inside', out.location.x - 600, out.location.y + 300)
    inside.operation = 'GREATER_THAN'
    inside.inputs[1].default_value = 0.5
    nt.links.new(lp.outputs['Transmission Depth'], inside.inputs[0])
    dark = N('ShaderNodeBsdfDiffuse', 'interior', out.location.x - 600, out.location.y - 300)
    dark.inputs['Color'].default_value = (0.03, 0.03, 0.03, 1.0)
    room = N('ShaderNodeMixShader', 'interior mix', out.location.x - 400, out.location.y)
    nt.links.new(inside.outputs[0], room.inputs['Fac'])
    nt.links.new(body.outputs['Shader'], room.inputs[1])
    nt.links.new(dark.outputs['BSDF'], room.inputs[2])
    # shadow and diffuse rays: plain tinted transparency (daylight into the rooms, no black interiors
    # with caustics off)
    let = N('ShaderNodeMath', 'shadow or diffuse', out.location.x - 400, out.location.y + 300)
    let.operation = 'MAXIMUM'
    nt.links.new(lp.outputs['Is Shadow Ray'], let.inputs[0])
    nt.links.new(lp.outputs['Is Diffuse Ray'], let.inputs[1])
    clear = N('ShaderNodeBsdfTransparent', 'clear', out.location.x - 400, out.location.y - 300)
    tmax = max(max(tint[:3]), 1e-6)
    clear.inputs['Color'].default_value = tuple(GLASS_DAYLIGHT * (0.7 + 0.3 * c / tmax) for c in tint[:3]) + (1.0,)
    final = N('ShaderNodeMixShader', 'glass', out.location.x - 200, out.location.y)
    nt.links.new(let.outputs[0], final.inputs['Fac'])
    nt.links.new(room.outputs['Shader'], final.inputs[1])
    nt.links.new(clear.outputs['BSDF'], final.inputs[2])
    nt.links.new(final.outputs['Shader'], out.inputs['Surface'])
    m['cycles_glass'] = 1


def tune_materials(mats=None):
    """Apply the Cycles-only glass/metal tuning to the materials that exist (by name)."""
    for name, g in GLASS.items():
        m = bpy.data.materials.get(name)
        if m is not None and m.use_nodes:
            tune_glass(m, **g)
    for name, vals in SHADING.items():
        m = bpy.data.materials.get(name)
        if m is None or not m.use_nodes:
            continue
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        if bsdf is None:
            continue
        for k, v in vals.items():
            _set(m, bsdf, k, v)


def restore_materials():
    """Undo tune_materials(): the materials are again exactly what materials.py built (for the glTF)."""
    for name, rec in _ORIG.items():
        m = bpy.data.materials.get(name)
        if m is None:
            continue
        nt = m.node_tree
        bsdf = nt.nodes.get('Principled BSDF')
        for n in [n for n in nt.nodes if n.name.startswith(_TAG)]:
            nt.nodes.remove(n)
        if bsdf is not None:
            for k, v in rec['inputs'].items():
                bsdf.inputs[k].default_value = v
            out = _output(m)
            if out is not None and rec.get('surface') is not None:
                nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        if 'cycles_glass' in m:
            del m['cycles_glass']
    _ORIG.clear()


class web_materials:
    """Context manager: materials as materials.py made them inside, Cycles tuning again after."""

    def __enter__(self):
        self.tuned = bool(_ORIG)
        restore_materials()
        return self

    def __exit__(self, *exc):
        if self.tuned:
            tune_materials()
        return False


def setup(scene, scale=0.5, samples=48):
    """Everything above, for build_complex.py."""
    meas = setup_world(scene)
    setup_sun(scene, meas)
    setup_render(scene, scale, samples)
    tune_materials()
    if meas is not None:
        print('[lighting] HDRI sun at u=%.4f v=%.4f (elev %.1f deg), sky E=%.3f, sun E=%.3f -> rotate %.1f deg, '
              'scale %.3f' % (meas['u'], meas['v'], meas['elevation'], meas['sky_irradiance'],
                              meas['sun_irradiance'], math.degrees(hdri_rotation(meas['u'])),
                              SKY_E / meas['sky_irradiance']))
    return meas
