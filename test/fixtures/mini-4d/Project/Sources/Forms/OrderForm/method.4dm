// LOCKS: FormMethod symbol kind. `Forms/<name>/method.4dm` becomes a
//        FormMethod symbol named `<form-name>.method`. Calls inside attribute
//        to that symbol.

Case of
  : (FORM Event code=On Load)
    DispatchedMethod
  : (FORM Event code=On Unload)
    EmGetTransaction("save"; "")
End case
