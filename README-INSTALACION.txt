LANZEC MOTO EXPRESS - PAQUETE LISTO PARA GITHUB / SUPABASE / NETLIFY

ESTRUCTURA
  .gitignore, _headers, *.html (raíz)
  js/config.js, js/app.js, js/nav.js
  supabase/schema.sql

INSTALACIÓN (en este orden)
1) js/config.js ya incluye tu clave publishable y el WhatsApp 51963334595. NUNCA uses la service_role/secret.
2) Supabase > SQL Editor > New query.
   2a) Si el proyecto ya tenía tablas de pruebas anteriores (error "enum" o similar) y NO tienes datos reales:
       ejecuta primero supabase/00_reset.sql. Luego borra los usuarios de prueba en Authentication > Users.
   2b) Pega TODO supabase/schema.sql y ejecuta (Run).
   Es re-ejecutable sin perder datos.
3) Authentication > Sign In / Providers: Email habilitado.
   IMPORTANTE: desactiva "Confirm email" (el concepto indica que NO se envían correos de verificación).
   Si lo dejas activo, Supabase enviará correos y el usuario no podrá entrar hasta confirmarlos.
4) Registra tu cuenta en registro-cliente.html y luego, en SQL Editor, ejecuta SOLO con tu correo:
   update public.profiles set role='admin', account_status='active' where email='TU_CORREO_ADMIN';
   Cierra sesión y vuelve a entrar: te llevará a admin.html.
5) Sube TODO el contenido de esta carpeta a GitHub y conéctalo a Netlify
   (sin build; Publish directory = raíz del repositorio).
6) Prueba en ventana privada (ver lista abajo).

FLUJO DEL SISTEMA
- Cliente: se registra -> pide suscripción (Yape + WhatsApp) -> admin aprueba pago -> puede solicitar servicios.
- Transportista: se registra (queda "pendiente") -> admin lo aprueba (independiente de la suscripción)
  -> activa suscripción -> ve solicitudes compatibles, acepta o contraoferta.
- Ofertas: el transportista puede aceptar el precio propuesto o enviar su oferta. Varios transportistas pueden ofertar;
  el cliente ve todas (ordenadas por precio, con foto y moto) y elige una. Al elegir, las demás se rechazan.
- Los datos de contacto (celular, placa) solo se muestran a las dos partes tras aceptar el servicio.
- El mensaje de WhatsApp incluye nombre, DNI, celular, correo, rol, plan y monto; el usuario adjunta manualmente
  la captura de pago (y la foto frontal del DNI si es transportista).
- El panel admin tiene un registro de auditoría (pagos, estados de cuentas, reclamos).
- Todas las transiciones de estado y precios se validan en el servidor (funciones RPC en schema.sql).

PRECIOS (fijados en el servidor, no manipulables desde el navegador)
  Cliente: semanal S/2 (7 días) · mensual S/10 (30 días)
  Transportista: semanal S/8 (7 días) · mensual S/25 (30 días)
  Yape: 963334595 · Titular Alex C.V.

LISTA DE PRUEBAS
  [ ] Registrar cliente, transportista y admin.
  [ ] Cliente sin suscripción NO puede solicitar servicio.
  [ ] Pedir suscripción -> abre WhatsApp -> admin aprueba -> cuenta regresiva aparece.
  [ ] Transportista pendiente no ve solicitudes; tras aprobar + suscripción sí.
  [ ] Dos transportistas ofertan distinto precio; el cliente ve ambas y elige una; la otra desaparece.
  [ ] Aceptar precio propuesto directo, iniciar, finalizar, cancelar.
  [ ] Un cliente no puede ver servicios de otro; un transportista no ve datos de contacto antes de aceptar.
  [ ] Reclamo enviado aparece en el panel admin.

NOTAS DE SEGURIDAD Y PRIVACIDAD
- La clave publishable es pública por diseño; la seguridad la dan las políticas RLS y RPC de schema.sql.
- Nadie puede cambiarse el rol a admin desde el navegador; solo con el SQL del paso 4.
- DNI y celular son datos personales: solo los ve el admin. No compartas respaldos.
  Publica una política de privacidad y términos antes de uso público.
- Las fotos de perfil están en un bucket público (URL con nombre aleatorio). No subas documentos ahí.
  El DNI se envía manualmente por WhatsApp (no se guarda en el sitio).
- Si cobras por el servicio en Perú, considera el Libro de Reclamaciones virtual (INDECOPI).

LIMITACIONES
- Sin GPS continuo, sin pagos automáticos, sin envío de correos. La lista de servicios se actualiza cada 8 segundos.
- El código se probó solo sintácticamente; pruébalo contra tu proyecto Supabase con la lista de arriba.
