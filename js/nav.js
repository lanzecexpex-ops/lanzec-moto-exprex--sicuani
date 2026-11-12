// Muestra "Cerrar sesión" solo si hay sesión de Supabase guardada en el navegador.
(function(){
  var logged=false;
  try{
    for(var i=0;i<localStorage.length;i++){
      var k=localStorage.key(i);
      if(/^sb-.*-auth-token$/.test(k)&&localStorage.getItem(k)){logged=true;break;}
    }
  }catch(e){}
  document.querySelectorAll('[data-logout]').forEach(function(b){b.style.display=logged?'':'none';});
})();
