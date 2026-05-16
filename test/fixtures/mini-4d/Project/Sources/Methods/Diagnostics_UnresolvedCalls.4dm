// LOCKS: deliberate UNRESOLVED references. Three bare-name calls to
//        non-existent project methods. Diagnostics tests assert that the
//        Problems panel surfaces unresolved edges for the OPEN document.
//        Resolution: each call emits an Unresolved symbol named
//        `IntPhantom_DoesNotExist{1,2,3}`.

IntPhantom_DoesNotExist1
IntPhantom_DoesNotExist2($foo)
$x:=IntPhantom_DoesNotExist3()
