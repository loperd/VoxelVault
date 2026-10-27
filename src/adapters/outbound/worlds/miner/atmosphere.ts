import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  ShaderMaterial,
} from 'three';
import type { Living } from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { MineParts } from './parts.ts';

export function atmosphere(p: MineParts): Living<ChestHandles>[] {
  const lava = p.group('08-molten-lava-cascade');
  const molten = new ShaderMaterial({
    uniforms: { time: { value: 0 } },
    side: DoubleSide,
    vertexShader:
      'varying vec2 v; void main(){v=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 v; uniform float time;
      void main(){ vec2 q=v*vec2(12.,18.); float f=sin(q.x*2.+sin(q.y*3.+time*.5))+sin(q.y*2.-time*.7)+sin(q.x*4.-q.y+time*.3);
      float cracks=pow(1.-abs(sin(f*2.8+q.y)),7.); vec3 c=mix(vec3(.72,.075,.008),vec3(1.,.48,.015),f*.18+.5); c=mix(c,vec3(1.,.91,.36),cracks); gl_FragColor=vec4(c,1.); }`,
  });
  for (let i = 0; i < 5; i++) {
    const surface = new Mesh(new PlaneGeometry(7, 4), molten);
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(-16 + i * 1.1, -1.7 - i * 1.5, 1 + i * 3.6);
    lava.add(surface);
    if (i < 4) {
      const fall = new Mesh(new PlaneGeometry(7, 1.5), molten);
      fall.position.set(-16 + i * 1.1, -2.45 - i * 1.5, 3 + i * 3.6);
      lava.add(fall);
    }
  }
  const glow = new PointLight('#ff5c16', 220, 35, 1.7);
  glow.position.set(-14, 0, 5);
  lava.add(glow);
  const water = p.group('09-underground-waterfalls');
  const waterMaterial = new ShaderMaterial({
    uniforms: { time: { value: 0 } },
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    vertexShader:
      'varying vec2 v; void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:
      'varying vec2 v; uniform float time; void main(){float streak=.5+.5*sin(v.y*95.+time*8.+sin(v.x*24.));gl_FragColor=vec4(.38,.64,.8,(.1+streak*.22)*sin(v.x*3.14159));}',
  });
  for (const [x, y, z, h] of [
    [20, 15, -24, 23],
    [18, 2, -10, 7],
  ] as const) {
    for (let i = 0; i < 7; i++) {
      const stream = new Mesh(new PlaneGeometry(0.15 + p.rand() * 0.3, h), waterMaterial);
      stream.position.set(x + i * 0.26, y, z + p.rand() * 0.4);
      water.add(stream);
    }
  }
  const ore = p.group('10-luminous-cyan-ore-veins');
  const crystalMaterial = new MeshBasicMaterial({ color: '#21d5f6' });
  const crystals = new InstancedMesh(p.box, crystalMaterial, 110),
    crystal = new Object3D();
  crystals.name = 'cyan-ore-crystals';
  for (let i = 0; i < 110; i++) {
    const side = i % 2 ? -1 : 1;
    crystal.position.set(side * (20 + p.rand() * 4), 3 + p.rand() * 27, -45 + p.rand() * 55);
    crystal.scale.set(0.12 + p.rand() * 0.35, 0.2 + p.rand() * 0.6, 0.2);
    crystal.rotation.z = p.rand();
    crystal.updateMatrix();
    crystals.setMatrixAt(i, crystal.matrix);
  }
  crystals.computeBoundingSphere();
  ore.add(crystals);
  for (const side of [-1, 1]) {
    const light = new PointLight('#15bdeb', 100, 30, 1.8);
    light.position.set(side * 21, 15, -8);
    ore.add(light);
  }
  const mist = p.group('11-ground-mist');
  const mistMaterial = new ShaderMaterial({
    uniforms: { time: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader:
      'varying vec2 v; void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:
      'varying vec2 v;uniform float time;void main(){float edge=pow(max(0.,1.-length((v-.5)*2.)),2.);float cloud=.6+.4*sin(v.x*20.+sin(v.y*13.)+time*.3);gl_FragColor=vec4(.48,.48,.53,edge*cloud*.16);}',
  });
  for (let i = 0; i < 14; i++) {
    const cloud = new Mesh(new PlaneGeometry(11, 3.5), mistMaterial);
    cloud.position.set((p.rand() - 0.5) * 44, -0.4 + p.rand(), -22 + p.rand() * 35);
    mist.add(cloud);
  }
  const particles = p.group('12-rising-embers');
  const positions = new Float32Array(180 * 3),
    phases = Array.from({ length: 180 }, () => p.rand());
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  particles.add(
    new Points(
      geometry,
      new PointsMaterial({
        color: '#ffa754',
        size: 0.085,
        transparent: true,
        opacity: 0.75,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  return [
    {
      update(context) {
        const t = context.time;
        molten.uniforms.time!.value = t;
        glow.intensity = 220 + Math.sin(t * 2.3) * 16;
        waterMaterial.uniforms.time!.value = t;
        mistMaterial.uniforms.time!.value = t;
        for (let i = 0; i < phases.length; i++) {
          const phase = phases[i]!;
          positions[i * 3] = -19 + phase * 12 + Math.sin(t * 0.7 + i) * 0.6;
          positions[i * 3 + 1] = -5 + ((t * (0.4 + phase) + i * 0.31) % 13);
          positions[i * 3 + 2] = -8 + ((i * 1.73) % 28);
        }
        geometry.attributes.position!.needsUpdate = true;
        for (const banner of p.root.getObjectByName('07-miners-guild-banners')!.children) {
          if (!(banner instanceof Mesh)) continue;
          const vertices = banner.geometry.attributes.position!;
          for (let i = 0; i < vertices.count; i++)
            vertices.setZ(
              i,
              (Math.sin(vertices.getX(i) * 2 + t * 1.4 + banner.position.x) *
                0.1 *
                (2.75 - vertices.getY(i))) /
                5.5,
            );
          vertices.needsUpdate = true;
        }
      },
    },
  ];
}
